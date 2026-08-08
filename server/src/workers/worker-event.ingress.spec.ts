import { NotFoundException } from '@nestjs/common';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  AgentStatusPayload,
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
    session: { updateMany: jest.Mock; findFirst: jest.Mock };
    taskEvent: { create: jest.Mock };
  };
  let realtime: { emit: jest.Mock };
  let idGen: { nextId: jest.Mock };

  beforeEach(() => {
    prisma = {
      worker: { findUnique: jest.fn().mockResolvedValue({ id: 'registered' }) },
      session: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
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

    it('message.part.delta 不落库不广播（D2 流式中间态）', async () => {
      const e = event('w_1', 'evw_3', 'message.part.delta', {
        sessionId: 'ses_1',
        text: '你好',
      });
      expect(await ingress.handleEvent(e)).toBe(true);
      expect(realtime.emit).not.toHaveBeenCalled();
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
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
});
