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
    session: { updateMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
    taskEvent: { create: jest.Mock };
    chatChannel: { findUnique: jest.Mock };
    message: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  };
  let realtime: { emit: jest.Mock };
  let idGen: { nextId: jest.Mock };

  beforeEach(() => {
    prisma = {
      worker: { findUnique: jest.fn().mockResolvedValue({ id: 'registered' }) },
    session: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
      taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
      chatChannel: { findUnique: jest.fn() },
      message: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
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
      const e = event('w_1', 'evw_1', 'worker.heartbeat', { load: { instances: 0 } });
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

    it('private 频道：delta 全量 parts 落库 processing（含 reasoning/tool）+ 广播 MESSAGE_PART_DELTA（channel scope）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({ id: 'c_dm', type: 'private' });
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

    it('task_group 频道：只累积结论性 text parts（reasoning/tool 过滤）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({ id: 'c_group', type: 'task_group' });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000044',
        channelId: 'c_group',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: {
          text: '结论',
          parts: [{ type: 'text', text: '结论', synthetic: false }],
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

      // reasoning/tool 不落库
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: {
              text: '结论',
              parts: [{ type: 'text', text: '结论', synthetic: false }],
            },
          }),
        }),
      );
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.MESSAGE_PART_DELTA,
        expect.objectContaining({
          delta: [{ type: 'text', text: '结论', synthetic: false }],
        }),
        { type: 'channel', id: 'c_group' },
      );
    });

    it('同一会话两次 delta → 累积更新同一 processing 消息（不新建）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({ id: 'c_dm', type: 'private' });
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

    it('task_group 纯 reasoning delta → 无结论 parts，不落库不广播', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({ id: 'c_group', type: 'task_group' });

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

      expect(prisma.message.findFirst).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('payload.agentId 缺失 → 经 sessionId 反查 Session.agentId 定位流式消息归属', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({ id: 'c_dm', type: 'private' });
      prisma.session.findUnique.mockResolvedValue({ agentId: 'a_1' });
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000045',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '你好', parts: [{ type: 'text', text: '你好', synthetic: false }] },
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
        { type: 'session.updated', sessionId: 's_mapped', taskId: 't_1', status: 'running' },
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
        where: { id: 's_old', status: 'running', instanceRef: { not: 'ses_new' } },
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
        where: { id: 's_old', status: 'running', instanceRef: { not: 'ses_new' } },
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

    it('status=error / 带 error 字段 emit agent.error', async () => {
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
        },
        { type: 'task', id: 't_1' },
      );
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
      prisma.chatChannel.findUnique.mockResolvedValue({ id: 'c_dm', type: 'private' });
      prisma.message.create.mockResolvedValue({
        id: 'm_delta',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '你好', parts: [{ type: 'text', text: '你好', synthetic: false }] },
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
        { type: 'session.updated', sessionId: 's_1', taskId: 't_1', status: 'running' },
      ]);
      expect(ingress.getLastActivity('s_1')).toBeDefined();
    });

    it('message.part.delta：通知回调 + 刷新 lastActivity（输出活动）', async () => {
      const acts: Array<Record<string, unknown>> = [];
      ingress.onSessionActivity((p) => acts.push(p));
      prisma.chatChannel.findUnique.mockResolvedValue({ id: 'c_dm', type: 'private' });
      prisma.message.create.mockResolvedValue({
        id: 'm_act1',
        channelId: 'c_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_1',
        content: { text: '你好', parts: [{ type: 'text', text: '你好', synthetic: false }] },
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
        { type: 'task.completed', sessionId: 's_1', taskId: 't_1', agentId: 'a_1' },
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
});
