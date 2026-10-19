import { NotFoundException } from '@nestjs/common';
import {
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  AgentStatusPayload,
  DELTA_PERSIST_INTERVAL_MS,
  SessionActivityPayload,
  TaskCompletedPayload,
  WorkerEventIngress,
} from './worker-event.ingress';
import { WorkerEventDto } from './dto/worker-event.dto';

/** 构造 WorkerEventDto（协议形状与 DTO 字段一致）。 */
function event(
  workerId: string,
  eventId: string,
  type: WorkerEventDto['type'],
  payload: Record<string, unknown>,
  seq = 0,
): WorkerEventDto {
  return { workerId, eventId, type, payload, seq } as WorkerEventDto;
}

describe('WorkerEventIngress', () => {
  let ingress: WorkerEventIngress;
  let prisma: {
    worker: { findUnique: jest.Mock };
    session: {
      updateMany: jest.Mock;
      update: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    taskEvent: { create: jest.Mock };
    chatChannel: { findUnique: jest.Mock; findFirst: jest.Mock };
    message: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    agentQuestion: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
  };
  let realtime: { emit: jest.Mock };
  let idGen: { nextId: jest.Mock };

  beforeEach(() => {
    prisma = {
      worker: { findUnique: jest.fn().mockResolvedValue({ id: 'registered' }) },
      session: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({ id: 's_1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
      chatChannel: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      message: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      agentQuestion: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'aq_1', status: 'pending' }),
        update: jest.fn().mockResolvedValue({ id: 'aq_1', status: 'pending' }),
      },
      task: {
        findUnique: jest.fn().mockResolvedValue({ id: 't_1', teamId: 'tm_1' }),
      },
      team: {
        findUnique: jest.fn().mockResolvedValue({ managedMode: false }),
      },
    };
    realtime = { emit: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    idGen = { nextId: jest.fn().mockResolvedValue('te_0000000042') };
    ingress = new WorkerEventIngress(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      idGen as unknown as IdGeneratorService,
    );
  });

  describe('F2 M2：workerId 注册校验', () => {
    it('未注册 workerId 的事件 → 404 WORKER_NOT_FOUND（防伪造注入）', async () => {
      prisma.worker.findUnique.mockResolvedValueOnce(null);
      const e = event('w_unknown', 'evw_1', 'session.updated', {
        sessionId: 's_1',
        status: 'active',
      });

      await expect(ingress.handleEvent(e)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(realtime.emit).not.toHaveBeenCalled();
    });
  });

  describe('幂等（D4 内存去重）', () => {
    it('同 workerId+eventId 首次处理返回 true，第二次返回 false 不重复处理', async () => {
      const e = event('w_1', 'evw_1', 'session.updated', {
        sessionId: 's_1',
        status: 'active',
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(await ingress.handleEvent(e)).toBe(false);
      expect(realtime.emit).toHaveBeenCalledTimes(1);
    });

    it('不同 worker 的同 eventId 不互相去重', async () => {
      const a = event('w_1', 'evw_1', 'session.updated', {
        sessionId: 's_1',
        status: 'active',
      });
      const b = event('w_2', 'evw_1', 'session.updated', {
        sessionId: 's_2',
        status: 'active',
      });
      expect(await ingress.handleEvent(a)).toBe(true);
      expect(await ingress.handleEvent(b)).toBe(true);
      expect(realtime.emit).toHaveBeenCalledTimes(2);
    });

    it('同 eventId 不同 type 也判重（key 为 workerId:eventId）', async () => {
      const a = event('w_1', 'evw_5', 'agent.status', { phase: 'thinking' });
      const b = event('w_1', 'evw_5', 'agent.status', { phase: 'operating' });
      expect(await ingress.handleEvent(a)).toBe(true);
      expect(await ingress.handleEvent(b)).toBe(false);
    });
  });

  describe('各 type 语义分派', () => {
    it('worker.heartbeat 忽略：不 emit 不落库', async () => {
      const e = event('w_1', 'evw_1', 'worker.heartbeat', {
        load: { instances: 0 },
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(realtime.emit).not.toHaveBeenCalled();
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('instance.created 仅确认：不 emit 不落库', async () => {
      const e = event('w_1', 'evw_2', 'instance.created', {
        sessionId: 'ses_1',
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('message.part.delta 缺 channelId → 跳过（无法定位频道）', async () => {
      const e = event('w_1', 'evw_3', 'message.part.delta', {
        sessionId: 'ses_1',
        text: '你好',
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(realtime.emit).not.toHaveBeenCalled();
      expect(prisma.chatChannel.findUnique).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('message.part.delta → 流式累积落库 + 广播（方案 A worker 主动推）', () => {
    /** 构造 delta 事件（eventId 唯一防去重）。 */
    const deltaEvent = (seq: number, payload: Record<string, unknown>) =>
      event('w_1', `evw_d${seq}`, 'message.part.delta', payload);

    /**
     * 可控时钟：生产码以 Date.now() 为 DELTA_PERSIST_INTERVAL_MS 节流闸门，
     * 用 spy 换一个可推进的时钟，避免测试里真实等待 1s。
     */
    let clockNow = 0;
    let dateNowSpy: jest.SpyInstance | undefined;
    const useFakeClock = () => {
      clockNow = 1_800_000_000_000;
      dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clockNow);
    };
    /** 推进跨过节流窗口（默认正好 +INTERVAL，闸门判定用 >= 放行下一次落库）。 */
    const tickPersistWindow = (ms: number = DELTA_PERSIST_INTERVAL_MS) => {
      clockNow += ms;
    };
    /**
     * 并发用例专用：每次 Date.now() 自增一个窗口。串行链上后到的 delta 必然跨过
     * 节流闸门（否则同窗口内被合并，测不到「第二个 findFirst 看到已建行 → update」）。
     */
    const useAutoAdvancingClock = () => {
      clockNow = 1_800_000_000_000;
      dateNowSpy = jest
        .spyOn(Date, 'now')
        .mockImplementation(() => (clockNow += DELTA_PERSIST_INTERVAL_MS));
    };
    afterEach(() => {
      dateNowSpy?.mockRestore();
      dateNowSpy = undefined;
    });

    it('private 频道：delta 全量 parts 落库 processing（含 reasoning/tool）+ 广播 MESSAGE_PART_DELTA（channel scope）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000043',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '你好',
          parts: [
            { type: 'reasoning', text: '思考中' },
            { type: 'text', text: '你好', synthetic: false },
            { type: 'tool', tool: 'x' },
          ],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(1, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [
              { type: 'reasoning', text: '思考中' },
              { type: 'text', text: '你好', synthetic: false },
              { type: 'tool', tool: 'x' },
            ],
            status: 'streaming',
          }),
        ),
      ).toBe(true);

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          channelId: 'c_dm',
          senderType: SENDER_TYPE.agent,
          status: MESSAGE_STATUS.processing,
          senderId: 'a_1',
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, content: true },
      });
      // 全量 parts（reasoning/tool 保留）落库为 processing 消息
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dm',
            senderType: SENDER_TYPE.agent,
            senderId: 'a_1',
            status: MESSAGE_STATUS.processing,
            content: {
              text: '你好',
              parts: [
                { type: 'reasoning', text: '思考中' },
                { type: 'text', text: '你好', synthetic: false },
                { type: 'tool', tool: 'x' },
              ],
            },
          }),
        }),
      );
      // 广播 MESSAGE_PART_DELTA（scope=channel，payload 含最新消息 + 本次 delta）
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        {
          message: expect.objectContaining({
            id: 'm_0000000043',
            status: MESSAGE_STATUS.processing,
          }),
          delta: [
            { type: 'reasoning', text: '思考中' },
            { type: 'text', text: '你好', synthetic: false },
            { type: 'tool', tool: 'x' },
          ],
        },
        { type: 'channel', id: 'c_dm' },
      );
    });

    it('注入提示防护：delta 含「注入提示」text part → 落库/广播均剔除，只留 agent 正常 part', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000099',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '你好',
          parts: [{ type: 'text', text: '你好', synthetic: false }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      await ingress.handleEvent(
        deltaEvent(99, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [
            {
              type: 'text',
              text: '【任务上下文】你的当前任务 ID：t_1。需要群聊历史时调用工具。',
            },
            { type: 'text', text: '你好', synthetic: false },
          ],
          status: 'streaming',
        }),
      );

      // 注入提示 part 被剔除后只剩 agent 正文（text 重算不含注入块）
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: {
              text: '你好',
              parts: [{ type: 'text', text: '你好', synthetic: false }],
            },
          }),
        }),
      );
      // 广播 delta 也不得携带注入 part
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.objectContaining({
          delta: [{ type: 'text', text: '你好', synthetic: false }],
        }),
        { type: 'channel', id: 'c_dm' },
      );
    });

    it('D1 回归：agent.status{error} → 同键组装态缓存失效，重试 delta 不得 update 已 failed 行', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const staleRowDate = new Date('2026-08-10T00:00:00Z');
      // delta 1：无缓存 → DB 无 processing 行 → 新建（建立组装态缓存项）
      prisma.message.create
        .mockResolvedValueOnce({
          id: 'm_stream',
          channelId: 'c_dm',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_1',
          content: {
            text: '第一段',
            parts: [{ type: 'text', text: '第一段', synthetic: false }],
          },
          mentions: null,
          status: MESSAGE_STATUS.processing,
          createdAt: staleRowDate,
        })
        // delta 3（error 后的重试）：缓存已失效 → 重新以 DB 定位（无 processing 行）→ 新建
        .mockResolvedValueOnce({
          id: 'm_retry',
          channelId: 'c_dm',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_1',
          content: {
            text: '重试',
            parts: [{ type: 'text', text: '重试', synthetic: false }],
          },
          mentions: null,
          status: MESSAGE_STATUS.processing,
          createdAt: new Date('2026-08-10T00:01:00Z'),
        });
      // delta 2（缓存命中）走 update；该行已被 dispatcher 标 failed，DB 无 processing 行
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.update.mockResolvedValue({
        id: 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '第一段第二段', parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.failed,
        createdAt: staleRowDate,
      });

      // 首轮：delta → delta（第二次命中组装态缓存，update 同一行）
      useFakeClock();
      await ingress.handleEvent(
        deltaEvent(201, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '第一段', synthetic: false }],
        }),
      );
      tickPersistWindow();
      await ingress.handleEvent(
        deltaEvent(202, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '第二段', synthetic: false }],
        }),
      );
      // worker 失败路径：只上送 agent.status{error}（+ session.updated{failed}），
      // 永不上送 task.completed（唯一 emitter 在成功路径 exec-server.ts:1592）
      await ingress.handleEvent(
        event('w_1', 'evw_d1_err', 'agent.status', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          status: 'error',
          error: 'worker 执行失败',
        }),
      );
      // 用户在同频道同 agent 重试：首 delta 必须重新以 DB 定位（不得命中残留缓存）
      await ingress.handleEvent(
        deltaEvent(203, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '重试', synthetic: false }],
        }),
      );

      // delta 2 的那一次 update 属 error 之前的正常累积；error 之后不得再 update
      expect(prisma.message.update).toHaveBeenCalledTimes(1);
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_stream' },
        data: expect.objectContaining({
          content: expect.objectContaining({ text: '第一段第二段' }),
        }),
      });
      // error 后 delta 重新以 DB 定位（findFirst）×2（delta 2 命中缓存不查）；
      // 未失效时 delta 3 也走缓存 → findFirst 只 1 次
      expect(prisma.message.findFirst).toHaveBeenCalledTimes(2);
      // 重试轮新建 processing 行，而不是把已 failed 行覆盖成新内容
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      expect(prisma.message.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dm',
            status: MESSAGE_STATUS.processing,
            content: expect.objectContaining({ text: '重试' }),
          }),
        }),
      );
      // SSE emit 载荷不变：agent.error 照常广播（修复不改变回调/广播行为）
      expect(realtime.emit).toHaveBeenCalledWith(
        'agent.error',
        expect.objectContaining({ error: 'worker 执行失败' }),
        { type: 'task', id: 't_1' },
      );
    });

    it('D2 回归：worker 崩溃/静默 watchdog 判死后重试 → 清扫失效组装态缓存，不得 update 已 failed 行', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const turnADate = new Date('2026-08-10T00:00:00Z');
      // 判死轮（turn A）：delta 建立组装态缓存项 + processing 行 m_A
      prisma.message.create
        .mockResolvedValueOnce({
          id: 'm_A',
          channelId: 'c_dm',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_1',
          content: {
            text: '第一段',
            parts: [{ type: 'text', text: '第一段', synthetic: false }],
          },
          mentions: null,
          status: MESSAGE_STATUS.processing,
          createdAt: turnADate,
        })
        // 重试轮（turn B）首 delta：缓存已失效 → DB 无 processing 行 → 新建
        .mockResolvedValueOnce({
          id: 'm_B',
          channelId: 'c_dm',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_1',
          content: {
            text: '重试',
            parts: [{ type: 'text', text: '重试', synthetic: false }],
          },
          mentions: null,
          status: MESSAGE_STATUS.processing,
          createdAt: new Date('2026-08-10T00:01:00Z'),
        });
      // markSessionIdleDead + 重派清扫后：m_A 已被标 failed，DB 中该频道该 agent
      // 不再有 processing 行（worker 崩溃/静默 watchdog 路径无任何 agent.status 回流）
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.update.mockResolvedValue({
        id: 'm_A',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '第一段', parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.failed,
        createdAt: turnADate,
      });

      // (i) turn A：delta → 建缓存（worker 随后崩溃/静默，无 task.completed/agent.status 回流）
      await ingress.handleEvent(
        deltaEvent(301, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '第一段', synthetic: false }],
        }),
      );
      // (ii) dispatcher 判死后重派清扫（markSessionIdleDead 无回流事件）→ 失效同键缓存
      //      （等价于 dispatchAgentMention 的 stale-row sweep 调用的公开钩子）
      ingress.invalidateDeltaStream('c_dm', 'a_1');
      // (iii) turn B 重试首 delta：必须重新以 DB 定位（不得命中 turn A 的残留缓存）
      await ingress.handleEvent(
        deltaEvent(302, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '重试', synthetic: false }],
        }),
      );

      // turn A 的那一次 create 之外，没有任何 message.update——已 failed 的 m_A 不被覆盖
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      expect(prisma.message.findFirst).toHaveBeenCalledTimes(2);
      // 重试轮新建 processing 行（不是改 m_A）
      expect(prisma.message.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dm',
            status: MESSAGE_STATUS.processing,
            content: expect.objectContaining({ text: '重试' }),
          }),
        }),
      );
    });

    it('D2 对照组（未失效时的腐败形态）：残留缓存命中 → message.update 覆盖已 failed 行', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_A',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '第一段', parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.update.mockResolvedValue({
        id: 'm_A',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '第一段重试', parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.failed,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      // 判死轮 delta → 建缓存；随后**不做**失效（即未打 dispatcher 钩子时的形态）
      useFakeClock();
      await ingress.handleEvent(
        deltaEvent(311, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '第一段', synthetic: false }],
        }),
      );
      tickPersistWindow();
      // 重试首 delta：命中 turn A 残留缓存 → update 已 failed 行（缺陷形态，被上一例钳制）
      await ingress.handleEvent(
        deltaEvent(312, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '重试', synthetic: false }],
        }),
      );

      // 缺陷形态的原始证据：message.update 作用在已 failed 行 m_A 上
      expect(prisma.message.update).toHaveBeenCalledTimes(1);
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_A' },
        data: expect.objectContaining({
          content: expect.objectContaining({ text: '第一段重试' }),
        }),
      });
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
    });

    it('非 private/team_group 来源 → 拒绝 message.part.delta，不查私聊、不落库、不广播', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_unsupported',
        type: 'broadcast',
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(45, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_unsupported',
            parts: [{ type: 'text', text: '不应写入', synthetic: false }],
          }),
        ),
      ).toBe(true);

      expect(prisma.chatChannel.findFirst).not.toHaveBeenCalled();
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('群聊触发 delta（来源=team_group）→ 落成员 team 私聊频道全量 parts（任务只归因，不参与定位）', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_1',
        teamId: 'tm_1',
        teamMemberId: 'tmm_1',
      });
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: 'c_group', type: 'team_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId === 'tmm_1')
          return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve(null);
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000044',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '结论',
          parts: [
            { type: 'reasoning', text: '内部思考' },
            { type: 'text', text: '结论', synthetic: false },
            { type: 'tool', tool: 'x' },
          ],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(2, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_group',
            parts: [
              { type: 'reasoning', text: '内部思考' },
              { type: 'text', text: '结论', synthetic: false },
              { type: 'tool', tool: 'x' },
            ],
          }),
        ),
      ).toBe(true);

      // 架构：处理过程（含 reasoning/tool）全量落 private 独白频道，群聊只显示最终转发结果
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dm',
            content: {
              text: '结论',
              parts: [
                { type: 'reasoning', text: '内部思考' },
                { type: 'text', text: '结论', synthetic: false },
                { type: 'tool', tool: 'x' },
              ],
            },
          }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.objectContaining({
          delta: [
            { type: 'reasoning', text: '内部思考' },
            { type: 'text', text: '结论', synthetic: false },
            { type: 'tool', tool: 'x' },
          ],
        }),
        { type: 'channel', id: 'c_dm' },
      );
    });

    it('群聊触发 delta 且无 private 频道 → 跳过落库（群聊只收 ACK + 工具直发，不收流式中间态）', async () => {
      // 来源频道=群聊；该 agent 无 private 频道（taskId_agentId 反查 null）
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: 'c_group', type: 'team_group' });
        return Promise.resolve(null);
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(5, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_group',
            parts: [{ type: 'text', text: '处理中', synthetic: false }],
          }),
        ),
      ).toBe(true);

      // 群聊只展示 ACK + MCP group_post 工具直发内容：处理过程 delta 不落库不广播
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('群聊触发 delta 且有 private 频道 → 仍落成员 team 私聊独白（带任务归因亦不走任务分支）', async () => {
      // 来源频道=群聊；成员有 team 私聊频道（c_dm）→ 照旧落 private，不跳过
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_1',
        teamId: 'tm_1',
        teamMemberId: 'tmm_1',
      });
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: 'c_group', type: 'team_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId === 'tmm_1')
          return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve(null);
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000047',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '处理中',
          parts: [{ type: 'text', text: '处理中', synthetic: false }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(6, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_group',
            parts: [{ type: 'text', text: '处理中', synthetic: false }],
          }),
        ),
      ).toBe(true);

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channelId: 'c_dm' }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.anything(),
        { type: 'channel', id: 'c_dm' },
      );
    });

    it('团队会话 delta 且无 private 频道 → 跳过落库（不写进群聊）', async () => {
      // 团队会话行：有 teamId/teamMemberId；来源 team_group；无 private 频道
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_1',
        teamId: 'tm_1',
        teamMemberId: 'tmm_1',
      });
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: 'c_tgroup', type: 'team_group' });
        return Promise.resolve(null);
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(50, {
            agentId: 'a_1',
            sessionId: 's_team',
            channelId: 'c_tgroup',
            parts: [{ type: 'text', text: '处理中', synthetic: false }],
          }),
        ),
      ).toBe(true);

      // 群聊只收最终 group_post 直发：流式中间态无 private 可落 → 不落库不广播
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('团队会话 delta 且有 private 频道 → 落成员私聊频道且 senderInstanceId=tmm_', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_1',
        teamId: 'tm_1',
        teamMemberId: 'tmm_1',
      });
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: 'c_tgroup', type: 'team_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamId === 'tm_1')
          return Promise.resolve({ id: 'c_tpriv', type: 'private' });
        return Promise.resolve(null);
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000051',
        channelId: 'c_tpriv',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        senderInstanceId: 'tmm_1',
        content: {
          text: '处理中',
          parts: [{ type: 'text', text: '处理中', synthetic: false }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(51, {
            agentId: 'a_1',
            sessionId: 's_team',
            channelId: 'c_tgroup',
            parts: [{ type: 'text', text: '处理中', synthetic: false }],
          }),
        ),
      ).toBe(true);

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_tpriv',
            senderInstanceId: 'tmm_1',
            status: MESSAGE_STATUS.processing,
          }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.anything(),
        { type: 'channel', id: 'c_tpriv' },
      );
    });

    it('Todo7 同成员多实例按 teamMemberId 精确匹配各自私聊频道（F3 P1 团队语义）', async () => {
      // 开发者-2 团队成员 tmm_dev_2：流式中间态必须落开发者-2 私聊频道 c_dev2，
      // 不得按 agentId 命中开发者-1 频道（F3 实测串扰缺陷根因，团队语义下按成员查）
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_developer',
        teamId: 'tm_1',
        teamMemberId: 'tmm_dev_2',
      });
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: 'c_group', type: 'team_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId)
          return Promise.resolve({ id: 'c_dev2', type: 'private' });
        return Promise.resolve(null);
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000048',
        channelId: 'c_dev2',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_developer',
        content: {
          text: '处理中',
          parts: [{ type: 'text', text: '处理中', synthetic: false }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(7, {
            taskId: 't_1',
            agentId: 'a_developer',
            sessionId: 's_dev2',
            channelId: 'c_group',
            parts: [{ type: 'text', text: '处理中', synthetic: false }],
          }),
        ),
      ).toBe(true);

      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_1', teamMemberId: 'tmm_dev_2', type: 'private' },
        select: { id: true, type: true },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dev2',
            senderId: 'a_developer',
            senderInstanceId: 'tmm_dev_2',
          }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.anything(),
        { type: 'channel', id: 'c_dev2' },
      );
    });

    it('同一会话两次 delta → 累积更新同一 processing 消息（不新建）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.message.findFirst.mockResolvedValueOnce({
        id: 'm_stream',
        content: {
          text: '你好',
          parts: [{ type: 'text', text: '你好', synthetic: false }],
        },
      });
      prisma.message.update.mockResolvedValue({
        id: 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '你好世界',
          parts: [
            { type: 'text', text: '你好', synthetic: false },
            { type: 'text', text: '世界', synthetic: false },
          ],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(3, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: '世界', synthetic: false }],
          }),
        ),
      ).toBe(true);

      expect(prisma.message.create).not.toHaveBeenCalled();
      // 累积更新：parts 追加 + text 重新拼接
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_stream' },
        data: {
          content: {
            text: '你好世界',
            parts: [
              { type: 'text', text: '你好', synthetic: false },
              { type: 'text', text: '世界', synthetic: false },
            ],
          },
        },
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.objectContaining({
          message: expect.objectContaining({ id: 'm_stream' }),
          delta: [{ type: 'text', text: '世界', synthetic: false }],
        }),
        { type: 'channel', id: 'c_dm' },
      );
    });

    it('稳态 delta 命中组装态缓存 → 不再每 delta 回读消息历史（message.findFirst 每条流只 1 次）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      useFakeClock();
      // 首 delta：无 processing 行 → findFirst(1) 返回 null → create 并写入组装态缓存
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.create.mockResolvedValue({
        id: 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: 'A',
          parts: [{ type: 'text', text: 'A', synthetic: false }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });
      prisma.message.update.mockResolvedValue({
        id: 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: 'AB',
          parts: [
            { type: 'text', text: 'A', synthetic: false },
            { type: 'text', text: 'B', synthetic: false },
          ],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(50, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: 'A', synthetic: false }],
          }),
        ),
      ).toBe(true);
      // 推进跨过节流窗口（DELTA_PERSIST_INTERVAL_MS）后，第二条 delta 命中组装态缓存
      // → message.update，不再 findFirst 回读整条消息历史
      tickPersistWindow();
      expect(
        await ingress.handleEvent(
          deltaEvent(51, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: 'B', synthetic: false }],
          }),
        ),
      ).toBe(true);

      // 关键判据（若回到「每 delta findFirst 全量回读 + 从 DB 重新推导」的老路 → 本断言失败）
      expect(prisma.message.findFirst).toHaveBeenCalledTimes(1);
      // 稳态累积仍从缓存组装态正确合并
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_stream' },
        data: {
          content: {
            text: 'AB',
            parts: [
              { type: 'text', text: 'A', synthetic: false },
              { type: 'text', text: 'B', synthetic: false },
            ],
          },
        },
      });
    });

    // ---- 写放大修复：DELTA_PERSIST_INTERVAL_MS 节流 + 终态/淘汰强制 flush ----

    it('节流：窗口内 N 个 delta 至多 1 次落库，但每个 delta 都广播一帧（帧内容=到该 delta 为止的全量累积）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const createdAt = new Date('2026-08-10T00:00:00Z');
      const rowOf = (content: unknown) => ({
        id: 'm_thr',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt,
      });
      const writtenContents: unknown[] = [];
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.create.mockImplementation(async (args: any) => {
        writtenContents.push(args.data.content);
        return rowOf(args.data.content);
      });
      prisma.message.update.mockImplementation(async (args: any) => {
        writtenContents.push(args.data.content);
        return rowOf(args.data.content);
      });
      useFakeClock();

      const chunks = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
      for (let i = 0; i < chunks.length; i++) {
        expect(
          await ingress.handleEvent(
            deltaEvent(400 + i, {
              taskId: 't_1',
              agentId: 'a_1',
              sessionId: 's_1',
              channelId: 'c_dm',
              parts: [{ type: 'text', text: chunks[i], synthetic: false }],
            }),
          ),
        ).toBe(true);
      }

      // 判据①（写放大被砍掉）：10 个 delta 挤在同一个窗口内 → 只有首条 create 落库，
      // message.update 一次都没有（旧实现这里会是 10 次全量行写 → binlog 放大根因）。
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(writtenContents).toHaveLength(1);

      // 判据②（广播一帧不少）：每个 delta 都广播一帧 MESSAGE_PART_DELTA
      const emits = realtime.emit.mock.calls.filter(
        (c) => c[0] === EVENT_TYPES.MESSAGE_PART_DELTA,
      );
      expect(emits).toHaveLength(chunks.length);
      // 判据③（帧与逐 delta 落库时同形）：每帧 message.content 都是到该 delta 为止的全量累积
      for (let i = 0; i < chunks.length; i++) {
        const accumulated = chunks
          .slice(0, i + 1)
          .map((t) => ({ type: 'text', text: t, synthetic: false }));
        expect(emits[i][1].message.content).toEqual({
          text: chunks.slice(0, i + 1).join(''),
          parts: accumulated,
        });
        expect(emits[i][1].delta).toEqual([
          { type: 'text', text: chunks[i], synthetic: false },
        ]);
        expect(emits[i][2]).toEqual({ type: 'channel', id: 'c_dm' });
      }

      // 窗口到期后才放行下一次落库，且写的是全量（不是只有最后一个增量）
      tickPersistWindow();
      await ingress.handleEvent(
        deltaEvent(420, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: 'K', synthetic: false }],
        }),
      );
      expect(prisma.message.update).toHaveBeenCalledTimes(1);
      expect(prisma.message.update.mock.calls[0][0].data.content).toEqual({
        text: 'ABCDEFGHIJK',
        parts: chunks
          .map((t) => ({ type: 'text', text: t, synthetic: false }))
          .concat([{ type: 'text', text: 'K', synthetic: false }]),
      });
    });

    it('终态 flush①（task.completed）：回调前补写窗口内跳过的尾段，DB 内容不截断', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const createdAt = new Date('2026-08-10T00:00:00Z');
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.create.mockImplementation(async (args: any) => ({
        id: 'm_tc',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: args.data.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt,
      }));
      prisma.message.update.mockImplementation(async (args: any) => ({
        id: 'm_tc',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: args.data.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt,
      }));
      // 回调触发时尾段必须已落库（顺序证据：flush 先于 notify）
      let updatesWhenCallbackFired = -1;
      ingress.onTaskCompleted(() => {
        updatesWhenCallbackFired = prisma.message.update.mock.calls.length;
      });
      useFakeClock();

      await ingress.handleEvent(
        deltaEvent(500, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '第一段', synthetic: false }],
        }),
      );
      await ingress.handleEvent(
        deltaEvent(501, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '第二段', synthetic: false }],
        }),
      );
      // 第二条在窗口内 → 只进内存组装态（dirty），DB 停在 '第一段'
      expect(prisma.message.update).not.toHaveBeenCalled();

      await ingress.handleEvent(
        event('w_1', 'evw_tc_flush', 'task.completed', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
        }),
      );

      // 终态 flush：未落库尾段被补写为**全量**（少这次写 = 用户消息在 DB 里永久截断）
      expect(prisma.message.update).toHaveBeenCalledTimes(1);
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_tc' },
        data: {
          content: {
            text: '第一段第二段',
            parts: [
              { type: 'text', text: '第一段', synthetic: false },
              { type: 'text', text: '第二段', synthetic: false },
            ],
          },
        },
      });
      expect(updatesWhenCallbackFired).toBe(1);
      // 终态纪律不变：缓存已失效，下一条流式首 delta 重新以 DB 定位
      await ingress.handleEvent(
        deltaEvent(502, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '第三段', synthetic: false }],
        }),
      );
      expect(prisma.message.findFirst).toHaveBeenCalledTimes(2);
    });

    it('终态 flush②（agent.status{error} D1 路径）：失效前补写尾段，且不覆盖已 failed 行', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const createdAt = new Date('2026-08-10T00:00:00Z');
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.create.mockImplementation(async (args: any) => ({
        id: 'm_err',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: args.data.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt,
      }));
      prisma.message.update.mockImplementation(async (args: any) => ({
        id: 'm_err',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: args.data.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt,
      }));
      useFakeClock();

      await ingress.handleEvent(
        deltaEvent(510, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '前半', synthetic: false }],
        }),
      );
      await ingress.handleEvent(
        deltaEvent(511, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '后半', synthetic: false }],
        }),
      );
      expect(prisma.message.update).not.toHaveBeenCalled();

      let updatesWhenErrorEmitted = -1;
      realtime.emit.mockImplementation(async (type: string) => {
        if (type === EVENT_TYPES.AGENT_ERROR) {
          updatesWhenErrorEmitted = prisma.message.update.mock.calls.length;
        }
        return { id: 'ev_1' };
      });

      await ingress.handleEvent(
        event('w_1', 'evw_err_flush', 'agent.status', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          status: 'error',
          error: 'worker 执行失败',
        }),
      );

      // 广播 agent.error 之前，尾段已补写（顺序证据）
      expect(updatesWhenErrorEmitted).toBe(1);
      expect(prisma.message.update).toHaveBeenCalledTimes(1);
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_err' },
        data: {
          content: {
            text: '前半后半',
            parts: [
              { type: 'text', text: '前半', synthetic: false },
              { type: 'text', text: '后半', synthetic: false },
            ],
          },
        },
      });
      // error 后重试：缓存已失效 → 重新以 DB 定位（DB 已无 processing 行 → 新建，不碰 m_err）
      await ingress.handleEvent(
        deltaEvent(512, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '重试', synthetic: false }],
        }),
      );
      expect(prisma.message.findFirst).toHaveBeenCalledTimes(2);
      // flush 之外没有任何额外 update（陈旧残留缓存的腐败形态：对旧行反复 update）
      expect(prisma.message.update).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
    });

    it('终态 flush③（D2 判死清扫 invalidateDeltaStream）：补写尾段且带 status=processing 守卫（不覆盖已 failed 行）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const createdAt = new Date('2026-08-10T00:00:00Z');
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.create.mockImplementation(async (args: any) => ({
        id: 'm_d2',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: args.data.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt,
      }));
      prisma.message.update.mockImplementation(async (args: any) => ({
        id: 'm_d2',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: args.data.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt,
      }));
      useFakeClock();

      await ingress.handleEvent(
        deltaEvent(520, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '判死轮', synthetic: false }],
        }),
      );
      await ingress.handleEvent(
        deltaEvent(521, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '尾段', synthetic: false }],
        }),
      );
      expect(prisma.message.update).not.toHaveBeenCalled();

      // dispatcher 判死后重派清扫（同步钩子）→ 带病条目被丢弃前先补写
      ingress.invalidateDeltaStream('c_dm', 'a_1');
      // 同键 delta 的 MISS 回读排在 flush 之后（串行链）→ await 之后 flush 必已落地
      await ingress.handleEvent(
        deltaEvent(522, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '重试', synthetic: false }],
        }),
      );

      expect(prisma.message.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.message.updateMany).toHaveBeenCalledWith({
        // 守卫：行已被标 failed / 已删除 → 0 行不写，绝不用流式内容覆盖已终态行
        where: { id: 'm_d2', status: MESSAGE_STATUS.processing },
        data: {
          content: {
            text: '判死轮尾段',
            parts: [
              { type: 'text', text: '判死轮', synthetic: false },
              { type: 'text', text: '尾段', synthetic: false },
            ],
          },
        },
      });
    });

    it('中段不丢失（淘汰路径）：缓存超限淘汰前先 flush 未落库尾段，同键 delta MISS 回读到全量', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      type Row = {
        id: string;
        channelId: string;
        senderType: string;
        senderId: string | null;
        content: unknown;
        status: string;
        createdAt: Date;
        mentions: null;
      };
      // 迷你内存 DB：写全部真实落到 rows，findFirst 从 rows 回读（复现 MISS 语义）
      const rows = new Map<string, Row>();
      let seq = 0;
      idGen.nextId.mockImplementation(async () => `m_evict_${++seq}`);
      prisma.message.findFirst.mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        const hit = [...rows.values()]
          .filter(
            (r) =>
              r.channelId === w.channelId &&
              r.senderType === w.senderType &&
              r.status === w.status &&
              (!w.senderId || r.senderId === w.senderId),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
        return hit ? { id: hit.id, content: hit.content } : null;
      });
      prisma.message.create.mockImplementation(async (args: any) => {
        const d = args.data;
        const row: Row = {
          id: d.id,
          channelId: d.channelId,
          senderType: d.senderType,
          senderId: d.senderId ?? null,
          content: d.content,
          status: d.status,
          createdAt: new Date(),
          mentions: null,
        };
        rows.set(row.id, row);
        return row;
      });
      prisma.message.update.mockImplementation(async (args: any) => {
        const row = rows.get(args.where.id);
        if (row) row.content = args.data.content;
        return row;
      });
      prisma.message.updateMany.mockImplementation(async (args: any) => {
        let count = 0;
        for (const row of rows.values()) {
          if (args.where.id && row.id !== args.where.id) continue;
          if (args.where.status && row.status !== args.where.status) continue;
          row.content = args.data.content;
          count += 1;
        }
        return { count };
      });
      useFakeClock();

      const send = (n: number, agentId: string, text: string) =>
        ingress.handleEvent(
          deltaEvent(n, {
            taskId: 't_1',
            agentId,
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text, synthetic: false }],
          }),
        );

      // 受害流 a_v：首 delta 落库 'V0'，第二条落在窗口内 → 只进内存组装态（dirty）
      await send(700, 'a_v', 'V0');
      await send(701, 'a_v', 'V1');
      expect((rows.get('m_evict_1') as Row).content).toEqual({
        text: 'V0',
        parts: [{ type: 'text', text: 'V0', synthetic: false }],
      });

      // 灌满其它流式键，把最旧（受害）条目挤出 ASSEMBLING_CACHE_MAX=256
      for (let i = 1; i <= 256; i++) {
        await send(1000 + i, `a_f${i}`, `F${i}`);
      }
      // 排空 fire-and-forget 的淘汰前 flush
      await new Promise((r) => setImmediate(r));
      // 淘汰前 flush 已把未落库尾段 'V1' 补写（否则 DB 停在 'V0' → 中段丢失）
      expect((rows.get('m_evict_1') as Row).content).toEqual({
        text: 'V0V1',
        parts: [
          { type: 'text', text: 'V0', synthetic: false },
          { type: 'text', text: 'V1', synthetic: false },
        ],
      });

      // 受害流下一条 delta：缓存已丢 → MISS 从 DB 回读 → 合并后不得丢中段
      await send(702, 'a_v', 'V2');
      expect((rows.get('m_evict_1') as Row).content).toEqual({
        text: 'V0V1V2',
        parts: [
          { type: 'text', text: 'V0', synthetic: false },
          { type: 'text', text: 'V1', synthetic: false },
          { type: 'text', text: 'V2', synthetic: false },
        ],
      });

      // flush 形态：guarded（status=processing）→ 已终态/已删除的行 0 行不写
      const flushCall = prisma.message.updateMany.mock.calls.find(
        (c) => c[0]?.where?.id === 'm_evict_1',
      );
      expect(flushCall).toBeDefined();
      expect(flushCall![0].where).toEqual({
        id: 'm_evict_1',
        status: MESSAGE_STATUS.processing,
      });
    });

    it('task.completed 终态化 → 清组装态缓存，下一条流式重新以 DB 定位（findFirst 再次被调用）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.create.mockImplementation(async (args: any) => ({
        id: args?.data?.id ?? 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: args?.data?.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      }));
      prisma.message.update.mockImplementation(async (args: any) => ({
        id: args?.where?.id ?? 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: args?.data?.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      }));

      await ingress.handleEvent(
        deltaEvent(60, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: 'A', synthetic: false }],
        }),
      );
      await ingress.handleEvent(
        deltaEvent(61, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: 'B', synthetic: false }],
        }),
      );
      // 两条 delta 共用一条 processing 消息 → findFirst 仅首条命中一次
      expect(prisma.message.findFirst).toHaveBeenCalledTimes(1);

      // 本轮流式结束：task.completed（携带同 channelId 使失效键与落库键一致）清掉该键
      await ingress.handleEvent(
        event('w_1', 'evw_tc_1', 'task.completed', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
        }),
      );

      // 下一条流式的首 delta：缓存已清 → MISS → 重新 findFirst 定位
      await ingress.handleEvent(
        deltaEvent(62, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: 'C', synthetic: false }],
        }),
      );
      expect(prisma.message.findFirst).toHaveBeenCalledTimes(2);
    });

    it('同 part.id 重发快照 → 原地替换该 part（last-write-wins），不追加重复快照', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const runningPart = {
        id: 'prt_1',
        type: 'tool',
        tool: 'read',
        state: { status: 'running', input: { path: 'a.ts' }, output: '' },
      };
      const donePart = {
        id: 'prt_1',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: { path: 'a.ts' }, output: '内容' },
      };
      prisma.message.findFirst.mockResolvedValueOnce({
        id: 'm_stream',
        content: { text: '', parts: [runningPart] },
      });
      prisma.message.update.mockResolvedValue({
        id: 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '', parts: [donePart] },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(31, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [donePart],
          }),
        ),
      ).toBe(true);

      // 同 id 替换而非追加 → content.parts 只剩一份快照
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_stream' },
        data: { content: { text: '', parts: [donePart] } },
      });
    });

    it('同 part.id 重发 + 新 part 混入 → 老 part 原地替换，新 part 按序追加到末尾', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const textV1 = {
        id: 'prt_t',
        type: 'text',
        text: '你好',
        synthetic: false,
      };
      const textV2 = {
        id: 'prt_t',
        type: 'text',
        text: '你好世界',
        synthetic: false,
      };
      const toolPart = {
        id: 'prt_2',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input: {}, output: 'ok' },
      };
      prisma.message.findFirst.mockResolvedValueOnce({
        id: 'm_stream',
        content: { text: '你好', parts: [textV1] },
      });
      prisma.message.update.mockResolvedValue({
        id: 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '你好世界', parts: [textV2, toolPart] },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(32, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [textV2, toolPart],
          }),
        ),
      ).toBe(true);

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_stream' },
        data: {
          content: { text: '你好世界', parts: [textV2, toolPart] },
        },
      });
    });

    it('无 id 的 part 保持追加语义（不因合并逻辑被覆盖）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      const oldPart = { type: 'text', text: '你好', synthetic: false };
      const newPart = { type: 'text', text: '世界', synthetic: false };
      prisma.message.findFirst.mockResolvedValueOnce({
        id: 'm_stream',
        content: { text: '你好', parts: [oldPart] },
      });
      prisma.message.update.mockResolvedValue({
        id: 'm_stream',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '你好世界', parts: [oldPart, newPart] },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      await ingress.handleEvent(
        deltaEvent(33, {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [newPart],
        }),
      );

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_stream' },
        data: {
          content: { text: '你好世界', parts: [oldPart, newPart] },
        },
      });
    });

    it('并发 delta（worker 不 await 连发）→ findFirst→create 串行化，只建一条 processing 行', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      // 两个 handler 若并发：两者 findFirst 都在对方的 create 之前进入（快照均为 null）
      // → 各建一行。串行化后第二个 findFirst 进入时第一行已存在 → 走 update。
      useAutoAdvancingClock();
      let created = false;
      prisma.message.findFirst.mockImplementation(async () => {
        // 同步快照此刻的可见性，再让出事件循环逼出真实并发
        const visible = created;
        await new Promise((r) => setImmediate(r));
        return visible
          ? { id: 'm_race', content: { text: '', parts: [] } }
          : null;
      });
      prisma.message.create.mockImplementation(async () => {
        created = true;
        return {
          id: 'm_race',
          channelId: 'c_dm',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_1',
          content: { text: '', parts: [] },
          mentions: null,
          status: MESSAGE_STATUS.processing,
          createdAt: new Date('2026-08-10T00:00:00Z'),
        };
      });
      prisma.message.update.mockResolvedValue({
        id: 'm_race',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '', parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      await Promise.all([
        ingress.handleEvent(
          deltaEvent(34, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: 'A', synthetic: false }],
          }),
        ),
        ingress.handleEvent(
          deltaEvent(35, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: 'B', synthetic: false }],
          }),
        ),
      ]);

      // 关键判据：create 至多一次（无串行化时为 2 次 → 重复独白消息）
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.update).toHaveBeenCalledTimes(1);
    });

    it('不同 agent 的 delta 不互相串行（各自独立建行）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.create.mockImplementation(async (args: any) => ({
        id: args?.data?.id,
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: args?.data?.senderId,
        content: args?.data?.content,
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      }));

      await Promise.all([
        ingress.handleEvent(
          deltaEvent(36, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: 'A', synthetic: false }],
          }),
        ),
        ingress.handleEvent(
          deltaEvent(37, {
            taskId: 't_1',
            agentId: 'a_2',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: 'B', synthetic: false }],
          }),
        ),
      ]);

      // 两个 agent 是两条不同的流式消息，各自建行（串行化键含 senderId）
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
    });

    it('纯 reasoning delta（群聊触发）→ 落成员 team 私聊独白全量（reasoning 亦入流式，不丢弃）', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_1',
        teamId: 'tm_1',
        teamMemberId: 'tmm_1',
      });
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: 'c_group', type: 'team_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId === 'tmm_1')
          return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve(null);
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000046',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '',
          parts: [{ type: 'reasoning', text: '内部思考' }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(4, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_group',
            parts: [{ type: 'reasoning', text: '内部思考' }],
          }),
        ),
      ).toBe(true);

      // 内心独白全量保留（含 reasoning 思考过程）；落 private 频道
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dm',
            content: expect.objectContaining({
              parts: [{ type: 'reasoning', text: '内部思考' }],
            }),
          }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.objectContaining({
          delta: [{ type: 'reasoning', text: '内部思考' }],
        }),
        { type: 'channel', id: 'c_dm' },
      );
    });

    it('payload.agentId 缺失 → 经 sessionId 反查 Session.agentId 定位流式消息归属', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.session.findUnique.mockResolvedValue({ agentId: 'a_1' });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000045',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '你好',
          parts: [{ type: 'text', text: '你好', synthetic: false }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(5, {
            taskId: 't_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: '你好', synthetic: false }],
          }),
        ),
      ).toBe(true);

      expect(prisma.session.findUnique).toHaveBeenCalledWith({
        where: { id: 's_1' },
        select: { agentId: true },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ senderId: 'a_1' }),
        }),
      );
    });
  });

  describe('session.updated → 更新 Session.status + emit', () => {
    it('合法 status 更新 DB 并 emit session.updated（task scope 透传）', async () => {
      const e = event('w_1', 'evw_4', 'session.updated', {
        sessionId: 's_1',
        status: 'frozen',
        taskId: 't_1',
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's_1', status: { not: 'frozen' } },
        data: { status: 'frozen' },
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        'session.updated',
        { sessionId: 's_1', status: 'frozen', workerId: 'w_1' },
        { type: 'task', id: 't_1' },
      );
    });

    it('非法 status 不更新 DB，但 emit 透传原值（防御性）', async () => {
      const e = event('w_1', 'evw_4', 'session.updated', {
        sessionId: 's_1',
        status: 'suspended',
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
      expect(realtime.emit).toHaveBeenCalledWith(
        'session.updated',
        { sessionId: 's_1', status: 'suspended', workerId: 'w_1' },
        { type: 'global' },
      );
    });

    it('DB 更新失败不抛错（吞错记日志，controller 恒定 202）', async () => {
      prisma.session.updateMany.mockRejectedValueOnce(new Error('db down'));
      const e = event('w_1', 'evw_4', 'session.updated', {
        sessionId: 's_1',
        status: 'active',
      });
      await expect(ingress.handleEvent(e)).resolves.toBe(true);
      expect(realtime.emit).toHaveBeenCalled();
    });

    it('Phase 4 新状态 running/idle：更新 DB + 广播 session.updated（mapSessionStatus 自动支持）', async () => {
      for (const s of ['running', 'idle']) {
        const e = event('w_1', `evw_r${s}`, 'session.updated', {
          sessionId: 's_1',
          status: s,
        });
        expect(await ingress.handleEvent(e)).toBe(true);
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
          where: { id: 's_1', status: { not: s } },
          data: { status: s },
        });
        expect(realtime.emit).toHaveBeenCalledWith(
          'session.updated',
          { sessionId: 's_1', status: s, workerId: 'w_1' },
          { type: 'global' },
        );
      }
    });

    it('wave1 对齐：worker 上送 ses_ 前缀 sessionId → 经 instanceRef 映射为平台主键再落库/emit/活动通知', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 's_mapped' });
      const activityPayloads: SessionActivityPayload[] = [];
      ingress.onSessionActivity((p) => activityPayloads.push(p));

      const e = event('w_1', 'evw_sesmap', 'session.updated', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_xxx',
        channelId: 'c_1',
        status: 'running',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      expect(prisma.session.findFirst).toHaveBeenCalledWith({
        where: { instanceRef: 'ses_xxx' },
        select: { id: true },
      });
      // 落库用平台主键（非 ses_，否则永远匹配不到 Session 行）
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's_mapped', status: { not: 'running' } },
        data: { status: 'running' },
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        'session.updated',
        { sessionId: 's_mapped', status: 'running', workerId: 'w_1' },
        { type: 'task', id: 't_1' },
      );
      // activity 通知用平台主键（dispatcher watchdog 以 target.sessionId=s_ 注册）
      expect(activityPayloads).toEqual([
        {
          type: 'session.updated',
          sessionId: 's_mapped',
          taskId: 't_1',
          status: 'running',
        },
      ]);
    });
  });

  describe('F3 缺陷②：ses_ 新会话反查失败 → 回写 running session 的 instanceRef', () => {
    it('回写唯一 running session → idle 能以平台主键落库（状态收敛 running → idle）', async () => {
      // 反查（findFirst by instanceRef）失败：instanceRef 仍指向旧会话（worker 404 重建）
      prisma.session.findFirst.mockResolvedValue(null);
      // worker w_1 唯一 running 会话 s_old（instanceRef 为旧值 ses_stale）
      prisma.session.findMany.mockResolvedValue([
        { id: 's_old', instanceRef: 'ses_stale' },
      ]);

      const e = event('w_1', 'evw_f3_1', 'session.updated', {
        taskId: 't_1',
        sessionId: 'ses_new',
        status: 'idle',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      // findMany：按 workerId + running 定位唯一会话
      expect(prisma.session.findMany).toHaveBeenCalledWith({
        where: { workerId: 'w_1', status: 'running' },
        select: { id: true, instanceRef: true },
      });
      // 回写 instanceRef → 新会话 id（幂等 where：仅 instanceRef != 新值时写）
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: {
          id: 's_old',
          status: 'running',
          instanceRef: { not: 'ses_new' },
        },
        data: { instanceRef: 'ses_new' },
      });
      // idle 以平台主键落库
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's_old', status: { not: 'idle' } },
        data: { status: 'idle' },
      });
      // emit/activity 通知用平台主键
      expect(realtime.emit).toHaveBeenCalledWith(
        'session.updated',
        { sessionId: 's_old', status: 'idle', workerId: 'w_1' },
        { type: 'task', id: 't_1' },
      );
    });

    it('s_ 前缀直接透传：不触发 findFirst 反查与 findMany 回写', async () => {
      const e = event('w_1', 'evw_f3_2', 'session.updated', {
        sessionId: 's_1',
        status: 'idle',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      expect(prisma.session.findFirst).not.toHaveBeenCalled();
      expect(prisma.session.findMany).not.toHaveBeenCalled();
      expect(prisma.session.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's_1', status: { not: 'idle' } },
        data: { status: 'idle' },
      });
    });

    it('反查命中（instanceRef 已是新值）→ 不回写，直接返回平台主键', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 's_mapped' });

      const e = event('w_1', 'evw_f3_3', 'session.updated', {
        sessionId: 'ses_new',
        status: 'running',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      expect(prisma.session.findMany).not.toHaveBeenCalled();
      // 只做状态更新，无 instanceRef 回写
      expect(prisma.session.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's_mapped', status: { not: 'running' } },
        data: { status: 'running' },
      });
    });

    it('回写分支 instanceRef 已是新值 → 幂等，不重复 updateMany', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.session.findMany.mockResolvedValue([
        { id: 's_old', instanceRef: 'ses_new' },
      ]);

      const e = event('w_1', 'evw_f3_4', 'session.updated', {
        sessionId: 'ses_new',
        status: 'idle',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      // 仅状态更新 1 次，无 instanceRef 回写
      expect(prisma.session.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.session.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { instanceRef: 'ses_new' } }),
      );
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: 's_old', status: { not: 'idle' } },
        data: { status: 'idle' },
      });
    });

    it('同 worker 多个 running 会话 → 不唯一，放弃回写（不误写）', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.session.findMany.mockResolvedValue([
        { id: 's_a', instanceRef: 'ses_a' },
        { id: 's_b', instanceRef: 'ses_b' },
      ]);

      const e = event('w_1', 'evw_f3_5', 'session.updated', {
        sessionId: 'ses_new',
        status: 'idle',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      // 无回写且 sessionId 解析失败 → 状态不落库，emit sessionId=null
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
      expect(realtime.emit).toHaveBeenCalledWith(
        'session.updated',
        { sessionId: null, status: 'idle', workerId: 'w_1' },
        { type: 'global' },
      );
    });

    it('Todo5：多 running + 事件带 taskId/agentId → 任务兜底已删：不回写不误写（emit sessionId=null）', async () => {
      // instanceRef 反查失败（findFirst）→ 唯一 running 定位失败（findMany 多条）
      // → 任务兜底分支已删 → undefined，不回写他会话
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.session.findMany.mockResolvedValue([
        { id: 's_a', instanceRef: 'ses_a' },
        { id: 's_b', instanceRef: 'ses_b' },
      ]);

      const e = event('w_1', 'evw_bug2_1', 'session.updated', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_new',
        status: 'idle',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      // 无 instanceRef 回写（任务锚定兜底已删），状态不落库
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
      expect(realtime.emit).toHaveBeenCalledWith(
        'session.updated',
        { sessionId: null, status: 'idle', workerId: 'w_1' },
        { type: 'task', id: 't_1' },
      );
    });

    it('Bug2：多 running + task 兜底未命中 → 放弃回写（不误写，emit sessionId=null）', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.session.findMany.mockResolvedValue([
        { id: 's_a', instanceRef: 'ses_a' },
        { id: 's_b', instanceRef: 'ses_b' },
      ]);

      const e = event('w_1', 'evw_bug2_2', 'session.updated', {
        taskId: 't_9',
        agentId: 'a_9',
        sessionId: 'ses_new',
        status: 'idle',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      expect(prisma.session.updateMany).not.toHaveBeenCalled();
      expect(realtime.emit).toHaveBeenCalledWith(
        'session.updated',
        { sessionId: null, status: 'idle', workerId: 'w_1' },
        { type: 'task', id: 't_9' },
      );
    });

    it('Todo5：多 running 下任务兜底已删 → 未知 instanceRef 返回 undefined，不误写（emit sessionId=null）', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      // 多 running 使唯一 running 分支失效；任务兜底已删 → undefined
      prisma.session.findMany.mockResolvedValue([
        { id: 's_a', instanceRef: 'ses_a' },
        { id: 's_b', instanceRef: 'ses_b' },
      ]);

      const e = event('w_1', 'evw_bug2_3', 'session.updated', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_new',
        status: 'running',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      // 无 instanceRef 回写，状态不落库
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
      expect(realtime.emit).toHaveBeenCalledWith(
        'session.updated',
        { sessionId: null, status: 'running', workerId: 'w_1' },
        { type: 'task', id: 't_1' },
      );
    });

    it('task.completed 也触发回写：回调 sessionId 为平台主键（后续落库/反查命中）', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.session.findMany.mockResolvedValue([
        { id: 's_old', instanceRef: 'ses_stale' },
      ]);
      const cbs: TaskCompletedPayload[] = [];
      ingress.onTaskCompleted((p) => cbs.push(p));

      const e = event('w_1', 'evw_f3_6', 'task.completed', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_new',
        text: '完成',
      });
      expect(await ingress.handleEvent(e)).toBe(true);

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: {
          id: 's_old',
          status: 'running',
          instanceRef: { not: 'ses_new' },
        },
        data: { instanceRef: 'ses_new' },
      });
      expect(cbs[0]).toMatchObject({ sessionId: 's_old' });
    });
  });

  describe('agent.status → emit agent.loading / agent.error', () => {
    it('无 status 字段默认 emit agent.loading（phase 透传）', async () => {
      const e = event('w_1', 'evw_6', 'agent.status', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_1',
        phase: 'thinking',
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(realtime.emit).toHaveBeenCalledWith(
        'agent.loading',
        {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 'ses_1',
          workerId: 'w_1',
          phase: 'thinking',
        },
        { type: 'task', id: 't_1' },
      );
    });

    it('status=error / 带 error 字段 emit agent.error（含推断 errorType）', async () => {
      const e = event('w_1', 'evw_7', 'agent.status', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_1',
        status: 'error',
        error: 'worker 无响应',
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(realtime.emit).toHaveBeenCalledWith(
        'agent.error',
        {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 'ses_1',
          workerId: 'w_1',
          error: 'worker 无响应',
          errorType: 'model_error',
        },
        { type: 'task', id: 't_1' },
      );
    });

    it('error 文本含凭据/配额/繁忙/缺模型特征 → errorType 分别推断 auth_failed/quota_exceeded/model_busy/model_not_found', async () => {
      for (const [error, errorType] of [
        ['模型调用报错：Invalid API key. (HTTP 401)', 'auth_failed'],
        ['余额不足，insufficient_quota', 'quota_exceeded'],
        ['模型繁忙 model_busy，稍后重试', 'model_busy'],
        [
          '模型调用报错：Model not found: opencode/gpt-5-nano. Did you mean: gpt-5-nano, gpt-5.4-nano?',
          'model_not_found',
        ],
      ] as const) {
        const e = event('w_1', `evw_${errorType}`, 'agent.status', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 'ses_1',
          status: 'error',
          error,
        });
        await ingress.handleEvent(e);
        expect(realtime.emit).toHaveBeenCalledWith(
          'agent.error',
          expect.objectContaining({ error, errorType }),
          { type: 'task', id: 't_1' },
        );
      }
    });

    it('phase 缺省补 operating（对齐两阶段指示器默认）', async () => {
      const e = event('w_1', 'evw_6', 'agent.status', {});
      await ingress.handleEvent(e);
      expect(realtime.emit).toHaveBeenCalledWith(
        'agent.loading',
        expect.objectContaining({ phase: 'operating' }),
        { type: 'global' },
      );
    });
  });

  describe('回调注册机制', () => {
    it('onTaskCompleted：task.completed 触发全部注册回调（Ingress 不 emit task.completed）', async () => {
      const cbs: TaskCompletedPayload[] = [];
      ingress.onTaskCompleted((p) => cbs.push(p));
      const cb2 = jest.fn();
      ingress.onTaskCompleted(cb2);

      const e = event('w_1', 'evw_8', 'task.completed', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 's_1',
        text: '完成',
        parts: [{ type: 'text', text: '完成' }],
        tokens: { total: 100, input: 40, output: 60 },
        cost: 0.0123,
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(cbs).toEqual([
        {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          workerId: 'w_1',
          text: '完成',
          parts: [{ type: 'text', text: '完成' }],
          tokens: { total: 100, input: 40, output: 60 },
          cost: 0.0123,
        },
      ]);
      expect(cb2).toHaveBeenCalledTimes(1);
      // 落库+广播归 T10 WorkerDispatcher 回调，Ingress 不 emit task.completed
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('F2 MINOR：task.completed sessionId 为 opencode 会话 id（非 s_ 前缀）→ 经 instanceRef 反查映射', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 's_mapped' });
      const cbs: TaskCompletedPayload[] = [];
      ingress.onTaskCompleted((p) => cbs.push(p));

      const e = event('w_1', 'evw_11', 'task.completed', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_xxx',
        text: '完成',
      });
      await ingress.handleEvent(e);

      expect(prisma.session.findFirst).toHaveBeenCalledWith({
        where: { instanceRef: 'ses_xxx' },
        select: { id: true },
      });
      expect(cbs[0]).toMatchObject({ sessionId: 's_mapped' });
    });

    it('F2 MINOR：映射查不到 → sessionId 留空（不阻塞回调）', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      const cbs: TaskCompletedPayload[] = [];
      ingress.onTaskCompleted((p) => cbs.push(p));

      const e = event('w_1', 'evw_12', 'task.completed', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 'ses_unknown',
        text: '完成',
      });
      await ingress.handleEvent(e);

      expect(cbs[0]).toMatchObject({ sessionId: undefined });
    });

    it('wave1 对齐：task.completed 上送 channelId → 回调透传（resolveChannel 群聊优先依赖）', async () => {
      const cbs: TaskCompletedPayload[] = [];
      ingress.onTaskCompleted((p) => cbs.push(p));

      const e = event('w_1', 'evw_13', 'task.completed', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 's_1',
        channelId: 'c_group',
        text: '完成',
      });
      await ingress.handleEvent(e);

      expect(cbs[0]).toMatchObject({ channelId: 'c_group' });
    });

    it('onAgentStatus：agent.status 触发注册回调', async () => {
      const got: AgentStatusPayload[] = [];
      ingress.onAgentStatus((p) => got.push(p));
      await ingress.handleEvent(
        event('w_1', 'evw_9', 'agent.status', {
          taskId: 't_1',
          agentId: 'a_1',
          phase: 'operating',
        }),
      );
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ taskId: 't_1', agentId: 'a_1' });
    });

    it('onAgentStatus 回调 sessionId 归一：ses_ 经 instanceRef 反查为平台主键（dispatcher 失败落库依赖）', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 's_9' });
      const got: AgentStatusPayload[] = [];
      ingress.onAgentStatus((p) => got.push(p));
      await ingress.handleEvent(
        event('w_1', 'evw_9b', 'agent.status', {
          taskId: 'team:tm_1',
          agentId: 'a_1',
          sessionId: 'ses_abc',
          status: 'error',
          error: '模型调用报错：boom',
        }),
      );
      expect(prisma.session.findFirst).toHaveBeenCalledWith({
        where: { instanceRef: 'ses_abc' },
        select: { id: true },
      });
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ sessionId: 's_9' });
    });

    it('onAgentStatus 回调 sessionId 归一：s_ 直接透传（无反查开销）', async () => {
      const got: AgentStatusPayload[] = [];
      ingress.onAgentStatus((p) => got.push(p));
      await ingress.handleEvent(
        event('w_1', 'evw_9c', 'agent.status', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_7',
          phase: 'operating',
        }),
      );
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
      expect(got[0]).toMatchObject({ sessionId: 's_7' });
    });

    it('onAgentStatus 回调 sessionId 归一：反查失败保留原始 ses_（调用方兜底）', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.session.findMany.mockResolvedValue([]);
      const got: AgentStatusPayload[] = [];
      ingress.onAgentStatus((p) => got.push(p));
      await ingress.handleEvent(
        event('w_1', 'evw_9d', 'agent.status', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 'ses_missing',
          phase: 'operating',
        }),
      );
      expect(got[0]).toMatchObject({ sessionId: 'ses_missing' });
    });

    it('回调抛异常被吞，不影响事件处理结果', async () => {
      ingress.onTaskCompleted(() => {
        throw new Error('callback boom');
      });
      const e = event('w_1', 'evw_10', 'task.completed', {});
      await expect(ingress.handleEvent(e)).resolves.toBe(true);
    });
  });

  describe('onSessionActivity：判死 watchdog 会话活动通知', () => {
    const activityPayloads: SessionActivityPayload[] = [];

    beforeEach(() => {
      activityPayloads.length = 0;
      ingress.onSessionActivity((p) => activityPayloads.push(p));
    });

    it('session.updated 合法状态（running）→ 触发活动通知（type/status/sessionId/taskId）', async () => {
      await ingress.handleEvent(
        event('w_1', 'evw_a1', 'session.updated', {
          sessionId: 's_1',
          status: 'running',
          taskId: 't_1',
        }),
      );
      expect(activityPayloads).toEqual([
        {
          type: 'session.updated',
          sessionId: 's_1',
          taskId: 't_1',
          status: 'running',
        },
      ]);
    });

    it('session.updated 非法状态（不更新 DB）→ 不触发活动通知', async () => {
      await ingress.handleEvent(
        event('w_1', 'evw_a2', 'session.updated', {
          sessionId: 's_1',
          status: 'suspended',
        }),
      );
      expect(activityPayloads).toHaveLength(0);
    });

    it('message.part.delta 成功处理 → 触发活动通知（刷新 idle 计时）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_delta',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '你好',
          parts: [{ type: 'text', text: '你好', synthetic: false }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });
      await ingress.handleEvent(
        event('w_1', 'evw_a3', 'message.part.delta', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          channelId: 'c_dm',
          parts: [{ type: 'text', text: '你好', synthetic: false }],
        }),
      );
      expect(activityPayloads).toEqual([
        {
          type: 'message.part.delta',
          sessionId: 's_1',
          taskId: 't_1',
          agentId: 'a_1',
        },
      ]);
    });

    it('agent.status → 触发活动通知', async () => {
      await ingress.handleEvent(
        event('w_1', 'evw_a4', 'agent.status', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          phase: 'operating',
        }),
      );
      expect(activityPayloads).toEqual([
        {
          type: 'agent.status',
          sessionId: 's_1',
          taskId: 't_1',
          agentId: 'a_1',
          status: undefined,
        },
      ]);
    });

    it('task.completed → 触发活动通知（本轮结束，dispatcher 停止 idle 追踪）', async () => {
      await ingress.handleEvent(
        event('w_1', 'evw_a5', 'task.completed', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          text: '完成',
        }),
      );
      expect(activityPayloads).toEqual([
        {
          type: 'task.completed',
          sessionId: 's_1',
          taskId: 't_1',
          agentId: 'a_1',
        },
      ]);
    });

    it('活动回调抛异常被吞，不影响事件处理', async () => {
      const thrower = jest.fn(() => {
        throw new Error('activity boom');
      });
      ingress.onSessionActivity(thrower);
      await expect(
        ingress.handleEvent(
          event('w_1', 'evw_a6', 'session.updated', {
            sessionId: 's_1',
            status: 'running',
          }),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('git.op → task_events 落库（T6 审计）', () => {
    it('完整 payload → taskEvent.create（eventType=git.op + metadata Json）', async () => {
      const e = event('w_1', 'evw_13', 'git.op', {
        taskId: 't_1',
        agentId: 'a_1',
        action: 'git_clone',
        repo_url: 'git@gitee.com:xishuhq/ketaops.git',
        exit: 0,
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(idGen.nextId).toHaveBeenCalledWith('te');
      expect(prisma.taskEvent.create).toHaveBeenCalledWith({
        data: {
          id: 'te_0000000042',
          taskId: 't_1',
          eventType: 'git.op',
          fromStatus: null,
          toStatus: null,
          actorType: 'agent',
          actorId: 'a_1',
          metadata: {
            agent: 'a_1',
            repo_url: 'git@gitee.com:xishuhq/ketaops.git',
            action: 'git_clone',
            exit: 0,
          },
        },
      });
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('error 状态 → metadata 含 exit + error，exit=0 不被丢弃', async () => {
      const e = event('w_1', 'evw_14', 'git.op', {
        taskId: 't_1',
        action: 'git_push',
        repo_url: 'origin',
        exit: 128,
        error: 'git push failed (exit 128)',
      });

      await ingress.handleEvent(e);
      expect(prisma.taskEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorId: null,
          metadata: {
            repo_url: 'origin',
            action: 'git_push',
            exit: 128,
            error: 'git push failed (exit 128)',
          },
        }),
      });
    });

    it('exit=0（成功操作）保留在 metadata', async () => {
      const e = event('w_1', 'evw_15', 'git.op', {
        taskId: 't_1',
        action: 'git_status',
        exit: 0,
      });

      await ingress.handleEvent(e);
      expect(prisma.taskEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: { action: 'git_status', exit: 0 },
        }),
      });
    });

    it('缺 taskId/action → 跳过不落库（日志确认）', async () => {
      const e = event('w_1', 'evw_16', 'git.op', {
        action: 'git_status',
        exit: 0,
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.taskEvent.create).not.toHaveBeenCalled();
    });

    it('落库失败吞错记 warn，handleEvent 仍返回 true（controller 恒定 202）', async () => {
      prisma.taskEvent.create.mockRejectedValueOnce(new Error('db down'));
      const e = event('w_1', 'evw_17', 'git.op', {
        taskId: 't_1',
        action: 'git_fetch',
        exit: 0,
      });

      await expect(ingress.handleEvent(e)).resolves.toBe(true);
    });
  });

  describe('判死 watchdog 活动源（onSessionActivity + sessionActivity 刷新）', () => {
    it('session.updated：通知回调（含 status/taskId）+ 刷新 lastActivity', async () => {
      const acts: Array<Record<string, unknown>> = [];
      ingress.onSessionActivity((p) => acts.push(p));
      const e = event('w_1', 'evw_act1', 'session.updated', {
        sessionId: 's_1',
        status: 'running',
        taskId: 't_1',
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(acts).toEqual([
        {
          type: 'session.updated',
          sessionId: 's_1',
          taskId: 't_1',
          status: 'running',
        },
      ]);
      expect(ingress.getLastActivity('s_1')).toBeDefined();
      await new Promise((r) => setTimeout(r, 0));
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_1' },
        data: { lastActivityAt: expect.any(Date) },
      });
    });

    it('todo-7 双写 fail-open：DB 回写失败仍返回 true，内存计时不受影响', async () => {
      prisma.session.update.mockRejectedValueOnce(new Error('db down'));
      const e = event('w_1', 'evw_act1b', 'session.updated', {
        sessionId: 's_1',
        status: 'running',
        taskId: 't_1',
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(ingress.getLastActivity('s_1')).toBeDefined();
    });

    it('message.part.delta：通知回调 + 刷新 lastActivity（输出活动）', async () => {
      const acts: Array<Record<string, unknown>> = [];
      ingress.onSessionActivity((p) => acts.push(p));
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        type: 'private',
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_act1',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '你好',
          parts: [{ type: 'text', text: '你好', synthetic: false }],
        },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          event('w_1', 'evw_act2', 'message.part.delta', {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_1',
            channelId: 'c_dm',
            parts: [{ type: 'text', text: '你好', synthetic: false }],
            status: 'streaming',
          }),
        ),
      ).toBe(true);
      expect(acts).toEqual([
        {
          type: 'message.part.delta',
          sessionId: 's_1',
          taskId: 't_1',
          agentId: 'a_1',
        },
      ]);
      expect(ingress.getLastActivity('s_1')).toBeDefined();
    });

    it('task.completed：通知回调 + 刷新 lastActivity（本轮结束）', async () => {
      const acts: Array<Record<string, unknown>> = [];
      ingress.onSessionActivity((p) => acts.push(p));
      const e = event('w_1', 'evw_act3', 'task.completed', {
        taskId: 't_1',
        agentId: 'a_1',
        sessionId: 's_1',
        text: '完成',
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(acts).toEqual([
        {
          type: 'task.completed',
          sessionId: 's_1',
          taskId: 't_1',
          agentId: 'a_1',
        },
      ]);
      expect(ingress.getLastActivity('s_1')).toBeDefined();
    });

    it('agent.status：通知回调但不清计时（不刷新 lastActivity，防状态上报保活）', async () => {
      const acts: Array<Record<string, unknown>> = [];
      ingress.onSessionActivity((p) => acts.push(p));
      // 先有一次输出活动（session.updated）建立 lastActivity 基线
      await ingress.handleEvent(
        event('w_1', 'evw_act4', 'session.updated', {
          sessionId: 's_1',
          status: 'running',
        }),
      );
      const baseline = ingress.getLastActivity('s_1');
      expect(baseline).toBeDefined();

      await ingress.handleEvent(
        event('w_1', 'evw_act5', 'agent.status', {
          taskId: 't_1',
          agentId: 'a_1',
          sessionId: 's_1',
          phase: 'operating',
        }),
      );
      expect(acts).toHaveLength(2);
      expect(acts[1]).toEqual(
        expect.objectContaining({ type: 'agent.status', sessionId: 's_1' }),
      );
      // agent.status 只通知不清计时——lastActivity 保持 session.updated 时的值
      expect(ingress.getLastActivity('s_1')).toBe(baseline);
    });
  });

  describe('session.question / session.permission → AgentQuestion 落库 + emit AGENT_QUESTION', () => {
    it('session.question 完整 payload → 新建 AgentQuestion（kind=question）+ emit（task scope）', async () => {
      const e = event('w_1', 'evw_q1', 'session.question', {
        sessionId: 's_1',
        requestId: 'que_1',
        taskId: 't_1',
        agentId: 'a_1',
        questions: [
          {
            question: '继续吗？',
            header: '确认',
            options: [{ label: '继续', description: 'x' }],
          },
        ],
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.agentQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requestId: 'que_1',
            sessionId: 's_1',
            taskId: 't_1',
            agentId: 'a_1',
            kind: 'question',
            status: 'pending',
          }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({ taskId: 't_1', agentId: 'a_1' }),
        { type: 'task', id: 't_1' },
      );
    });

    it('session.permission → 新建 AgentQuestion（kind=permission），content 存 title/pattern/type', async () => {
      const e = event('w_1', 'evw_p1', 'session.permission', {
        sessionId: 's_1',
        permissionId: 'per_1',
        taskId: 't_1',
        agentId: 'a_1',
        type: 'bash',
        pattern: '/data/*',
        title: 'bash',
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.agentQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requestId: 'per_1',
            kind: 'permission',
            content: { title: 'bash', pattern: '/data/*', type: 'bash' },
          }),
        }),
      );
    });

    it('团队会话 permission（payload.taskId 空）→ team scope + payload 补 team:<id>/teamId（前端可见性与 scope 过滤放行）', async () => {
      prisma.session.findUnique.mockResolvedValueOnce({
        taskId: null,
        agentId: 'a_pm',
        teamId: 'tm_9',
      });
      const e = event('w_1', 'evw_p9', 'session.permission', {
        sessionId: 's_9',
        permissionId: 'per_9',
        type: 'external_directory',
        pattern: '/root/.config/opencode/*',
        title: 'external_directory',
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      // 行保持空 taskId（findAll 的 teamId 路径经 sessionId ∈ 团队会话命中）
      expect(prisma.agentQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requestId: 'per_9',
            sessionId: 's_9',
            taskId: '',
            kind: 'permission',
          }),
        }),
      );
      // payload 补 team:<teamId> + 顶层 teamId；scope 发 team 域（否则 scope=all 可见性丢帧）
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({
          taskId: 'team:tm_9',
          teamId: 'tm_9',
          question: expect.objectContaining({
            taskId: 'team:tm_9',
            kind: 'permission',
            agentId: 'a_pm',
          }),
        }),
        { type: 'team', id: 'tm_9' },
      );
    });

    it('团队会话且团队 managedMode=true → managed 标记 + managedMode（主 Agent 确认路由激活）', async () => {
      prisma.session.findUnique.mockResolvedValueOnce({
        taskId: null,
        agentId: 'a_pm',
        teamId: 'tm_9',
      });
      prisma.team.findUnique.mockResolvedValue({ managedMode: true });
      const e = event('w_1', 'evw_p10', 'session.question', {
        sessionId: 's_9',
        requestId: 'que_9',
        questions: [{ question: '继续？', header: '确认', options: [] }],
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({
          managed: true,
          taskId: 'team:tm_9',
          question: expect.objectContaining({ managedMode: true }),
        }),
        { type: 'team', id: 'tm_9' },
      );
    });

    it('requestId 已存在且 pending → 更新 content 不新建（幂等）；已终态 → 跳过不重复上报', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValueOnce({
        id: 'aq_1',
        status: 'pending',
      });
      const e = event('w_1', 'evw_q2', 'session.question', {
        sessionId: 's_1',
        requestId: 'que_1',
        taskId: 't_1',
        agentId: 'a_1',
        questions: [{ question: 'q2', header: 'h2', options: [] }],
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.agentQuestion.create).not.toHaveBeenCalled();
      expect(prisma.agentQuestion.update).toHaveBeenCalled();

      prisma.agentQuestion.findUnique.mockResolvedValueOnce({
        id: 'aq_1',
        status: 'resolved',
      });
      prisma.agentQuestion.create.mockClear();
      prisma.agentQuestion.update.mockClear();
      await ingress.handleEvent(
        event('w_1', 'evw_q3', 'session.question', {
          sessionId: 's_1',
          requestId: 'que_1',
          taskId: 't_1',
          agentId: 'a_1',
          questions: [],
        }),
      );
      expect(prisma.agentQuestion.create).not.toHaveBeenCalled();
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
    });

    it('ses_ 前缀 sessionId → 经 instanceRef 反查平台主键再落库（wave1 对齐）', async () => {
      prisma.session.findFirst.mockResolvedValueOnce({ id: 's_1' });
      const e = event('w_1', 'evw_q4', 'session.question', {
        sessionId: 'ses_abc',
        requestId: 'que_2',
        taskId: 't_1',
        agentId: 'a_1',
        questions: [],
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.agentQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionId: 's_1',
            requestId: 'que_2',
          }),
        }),
      );
    });

    it('ses_ 反查失败（多 running 会话不唯一）→ 不丢弃，保留原始 ses_ id 落库 + payload taskId/agentId', async () => {
      prisma.session.findFirst.mockResolvedValue(null); // resolveSessionIdByInstanceRef 未命中
      prisma.session.findMany.mockResolvedValue([
        { id: 's_1', instanceRef: 'ses_x' },
        { id: 's_2', instanceRef: 'ses_y' },
      ]); // adoptNewInstanceRef 不唯一 → 放弃回写
      const e = event('w_1', 'evw_q7', 'session.question', {
        sessionId: 'ses_abc',
        requestId: 'que_3',
        taskId: 't_9',
        agentId: 'a_9',
        questions: [{ question: 'q', header: 'h', options: [] }],
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.agentQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionId: 'ses_abc', // 原始 opencode 会话 id 兜底保留
            requestId: 'que_3',
            taskId: 't_9', // payload 透传
            agentId: 'a_9',
          }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({
          sessionId: 'ses_abc',
          taskId: 't_9',
          agentId: 'a_9',
        }),
        { type: 'task', id: 't_9' },
      );
    });

    it('缺 requestId/permissionId → 跳过（不落库不 emit）', async () => {
      const e = event('w_1', 'evw_q5', 'session.question', {
        sessionId: 's_1',
        taskId: 't_1',
        agentId: 'a_1',
        questions: [],
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.agentQuestion.create).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('DB 落库失败 → 吞错返回 true（controller 恒定 202，事件回流尽力而为）', async () => {
      prisma.agentQuestion.create.mockRejectedValueOnce(new Error('db down'));
      const e = event('w_1', 'evw_q6', 'session.question', {
        sessionId: 's_1',
        requestId: 'que_1',
        taskId: 't_1',
        agentId: 'a_1',
        questions: [],
      });

      await expect(ingress.handleEvent(e)).resolves.toBe(true);
    });
  });

  describe('Todo7 ingress 收敛 team-only（delta/question/completed）', () => {
    const deltaEvent = (seq: number, payload: Record<string, unknown>) =>
      event('w_1', `evw_su7_${seq}`, 'message.part.delta', payload);

    it('delta 团队唯一：带 taskId 归因 + 团队会话 → 只查成员私聊频道（不查任务频道），落库 senderInstanceId=tmm_', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_1',
        teamId: 'tm_1',
        teamMemberId: 'tmm_1',
      });
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_tgroup',
        type: 'team_group',
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId === 'tmm_1')
          return Promise.resolve({ id: 'c_tpriv', type: 'private' });
        return Promise.resolve(null);
      });
      prisma.message.create.mockResolvedValue({
        id: 'm_su7_1',
        channelId: 'c_tpriv',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        senderInstanceId: 'tmm_1',
        content: { text: '处理中', parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.processing,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });

      expect(
        await ingress.handleEvent(
          deltaEvent(1, {
            taskId: 't_1',
            agentId: 'a_1',
            sessionId: 's_team',
            channelId: 'c_tgroup',
            parts: [{ type: 'text', text: '处理中', synthetic: false }],
          }),
        ),
      ).toBe(true);

      // 团队唯一分支：按（团队，成员）查私聊频道，不再按（任务，实例/agent）查询
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_1', teamMemberId: 'tmm_1', type: 'private' },
        select: { id: true, type: true },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_tpriv',
            senderInstanceId: 'tmm_1',
            status: MESSAGE_STATUS.processing,
          }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.anything(),
        { type: 'channel', id: 'c_tpriv' },
      );
    });

    it('question 缺 taskId → AgentQuestion.taskId 写空串归因（沿用既有写法）', async () => {
      const e = event('w_1', 'evw_su7_q1', 'session.question', {
        sessionId: 's_team',
        agentId: 'a_1',
        requestId: 'que_su7_1',
        questions: [{ text: '确认吗？' }],
      });

      expect(await ingress.handleEvent(e)).toBe(true);
      expect(prisma.agentQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ taskId: '', requestId: 'que_su7_1' }),
        }),
      );
    });
  });
});
