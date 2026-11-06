import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SessionLifecycleService } from './session-lifecycle.service';
import { SessionTurnsService } from './session-turns.service';

/** P3 全局会话底座单测：成员会话 ensure + 轮次台账（mock Prisma）。 */
describe('全局会话（P3）', () => {
  let tx: any;
  let prisma: any;
  let idGen: any;

  beforeEach(() => {
    tx = {
      member: { findUnique: jest.fn() },
      session: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
      },
      teamMember: { findMany: jest.fn() },
      taskGroupInstance: { updateMany: jest.fn() },
      sessionTurn: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    };
    prisma = {
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
      session: {
        findUnique: jest.fn(),
      },
      sessionTurn: {
        findMany: jest.fn(),
      },
    };
    idGen = {
      nextId: jest.fn().mockResolvedValue('s_0000000001'),
      seed: jest.fn(),
    };
  });

  describe('SessionLifecycleService.ensureMemberSession', () => {
    const service = () => new SessionLifecycleService(prisma, idGen);

    it('首次：创建 team-mode 会话，memberKey=memberId 并写入当前上下文', async () => {
      tx.member.findUnique.mockResolvedValue({
        id: 'mbr_1',
        name: '架构师-老周',
        status: 'active',
        agentId: 'a_arch',
      });
      tx.session.findUnique.mockResolvedValue(null);
      tx.session.create.mockImplementation(({ data }: any) => ({ ...data }));

      const result: any = await service().ensureMemberSession('mbr_1', {
        seatId: 'tmm_1',
        teamId: 'tm_1',
        channelId: 'c_1',
      });

      expect(tx.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: 'mbr_1',
          memberKey: 'mbr_1',
          seatId: 'tmm_1',
          currentTeamId: 'tm_1',
          currentChannelId: 'c_1',
          teamId: 'tm_1',
          teamMemberId: 'tmm_1',
          agentId: 'a_arch',
          taskId: null,
          status: 'created',
        }),
        select: expect.anything(),
      });
      expect(result).toMatchObject({ memberId: 'mbr_1', reused: false });
    });

    it('已有：复用并只更新显式提供的上下文字段', async () => {
      tx.member.findUnique.mockResolvedValue({
        id: 'mbr_1',
        name: 'x',
        status: 'active',
        agentId: 'a_arch',
      });
      tx.session.findUnique.mockResolvedValue({
        id: 's_1',
        memberId: 'mbr_1',
        memberKey: 'mbr_1',
        seatId: 'tmm_1',
        currentTeamId: 'tm_1',
        currentTaskId: null,
        currentChannelId: 'c_old',
        agentId: 'a_arch',
        workerId: null,
        instanceRef: null,
        status: 'created',
        busyState: 'idle',
        turnSeq: 0,
      });
      tx.session.update.mockImplementation(({ data }: any) => ({
        id: 's_1',
        ...data,
      }));

      const result: any = await service().ensureMemberSession('mbr_1', {
        teamId: 'tm_2',
        channelId: 'c_new',
      });

      expect(tx.session.create).not.toHaveBeenCalled();
      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: 's_1' },
        data: {
          currentTeamId: 'tm_2',
          teamId: 'tm_2',
          currentChannelId: 'c_new',
        },
        select: expect.anything(),
      });
      expect(result.reused).toBe(true);
    });

    it('成员不存在 → 404；已停用 → 400', async () => {
      tx.member.findUnique.mockResolvedValueOnce(null);
      await expect(
        service().ensureMemberSession('mbr_x'),
      ).rejects.toBeInstanceOf(NotFoundException);
      tx.member.findUnique.mockResolvedValueOnce({
        id: 'mbr_1',
        name: 'x',
        status: 'disabled',
        agentId: 'a_arch',
      });
      await expect(
        service().ensureMemberSession('mbr_1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('SessionLifecycleService.resetMemberSession', () => {
    const service = () => new SessionLifecycleService(prisma, idGen);

    it('无全局会话 → reset=0（幂等）', async () => {
      tx.session.findUnique.mockResolvedValue(null);
      const r = await service().resetMemberSession('mbr_1');
      expect(r).toEqual({ reset: 0, sessionId: null });
    });

    it('有会话：软移除实例、取消未完成轮次、删旧建新（member_key 保持）', async () => {
      tx.session.findUnique.mockResolvedValue({
        id: 's_old',
        memberId: 'mbr_1',
        agentId: 'a_arch',
        seatId: 'tmm_1',
        currentTeamId: 'tm_1',
        currentTaskId: null,
        currentChannelId: 'c_1',
      });
      tx.member.findUnique.mockResolvedValue({
        id: 'mbr_1',
        name: 'x',
        status: 'active',
        agentId: 'a_arch',
      });
      tx.teamMember.findMany.mockResolvedValue([{ id: 'tmm_1', teamId: 'tm_1' }]);
      tx.taskGroupInstance.updateMany.mockResolvedValue({ count: 1 });
      tx.sessionTurn.updateMany.mockResolvedValue({ count: 1 });
      tx.session.delete.mockResolvedValue({});
      tx.session.create.mockImplementation(({ data }: any) => ({
        id: data.id,
        ...data,
      }));
      idGen.nextId.mockResolvedValue('s_new');

      const r = await service().resetMemberSession('mbr_1', {
        reason: 'member_manual_reset',
      });

      expect(tx.taskGroupInstance.updateMany).toHaveBeenCalledWith({
        where: { teamId: 'tm_1', teamMemberId: 'tmm_1', removedAt: null },
        data: { removedAt: expect.any(Date) },
      });
      expect(tx.sessionTurn.updateMany).toHaveBeenCalledWith({
        where: {
          sessionId: 's_old',
          status: { in: ['pending', 'running'] },
        },
        data: expect.objectContaining({
          status: 'cancelled',
          runningKey: null,
          error: 'member_manual_reset',
        }),
      });
      expect(tx.session.delete).toHaveBeenCalledWith({ where: { id: 's_old' } });
      expect(tx.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memberId: 'mbr_1',
          memberKey: 'mbr_1',
          teamId: 'tm_1',
          teamMemberId: 'tmm_1',
          status: 'created',
        }),
        select: { id: true },
      });
      expect(r).toEqual({ reset: 1, sessionId: 's_new' });
    });

    it('成员不存在 → 404', async () => {
      tx.session.findUnique.mockResolvedValue({
        id: 's_old',
        memberId: 'mbr_x',
        agentId: 'a',
        seatId: null,
        currentTeamId: null,
        currentTaskId: null,
        currentChannelId: null,
      });
      tx.member.findUnique.mockResolvedValue(null);
      await expect(service().resetMemberSession('mbr_x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('SessionTurnsService', () => {
    const service = () => new SessionTurnsService(prisma, idGen);

    it('enqueue：turnSeq 自增 + 落 pending 轮次', async () => {
      tx.session.findUnique.mockResolvedValue({ id: 's_1', memberId: 'mbr_1' });
      tx.session.update.mockResolvedValue({ turnSeq: 3 });
      tx.sessionTurn.create.mockImplementation(({ data }: any) => ({
        ...data,
      }));

      const turn: any = await service().enqueue({
        sessionId: 's_1',
        memberId: 'mbr_1',
        seatId: 'tmm_1',
        teamId: 'tm_1',
        channelId: 'c_1',
        messageId: 'm_1',
      });

      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: 's_1' },
        data: { turnSeq: { increment: 1 } },
        select: { turnSeq: true },
      });
      expect(turn).toMatchObject({
        sessionId: 's_1',
        seq: 3,
        memberId: 'mbr_1',
        channelId: 'c_1',
        status: 'pending',
      });
    });

    it('enqueue：成员与会话不符 → 400', async () => {
      tx.session.findUnique.mockResolvedValue({ id: 's_1', memberId: 'mbr_1' });
      await expect(
        service().enqueue({ sessionId: 's_1', memberId: 'mbr_2' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('claimNext：无 pending → null；有则置 running 并设置 busy', async () => {
      tx.sessionTurn.findFirst
        .mockResolvedValueOnce(null) // running check
        .mockResolvedValueOnce(null); // pending check
      expect(await service().claimNext('s_1')).toBeNull();

      tx.sessionTurn.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'st_1' });
      tx.sessionTurn.updateMany.mockResolvedValue({ count: 1 });
      tx.session.update.mockResolvedValue({});
      tx.sessionTurn.findUnique.mockResolvedValue({
        id: 'st_1',
        status: 'running',
      });

      const claimed: any = await service().claimNext('s_1');
      expect(tx.sessionTurn.updateMany).toHaveBeenCalledWith({
        where: { id: 'st_1', status: 'pending' },
        data: {
          status: 'running',
          runningKey: 's_1',
          startedAt: expect.any(Date),
        },
      });
      expect(claimed.id).toBe('st_1');
    });

    it('finish：轮次收口为 done，并清 busy 状态/记录 outcome', async () => {
      tx.sessionTurn.findUnique.mockResolvedValue({
        id: 'st_1',
        sessionId: 's_1',
        status: 'running',
      });
      tx.sessionTurn.update.mockResolvedValue({});
      tx.session.update.mockResolvedValue({});

      const result: any = await service().finish('st_1', 'done', {
        engineMessageId: 'em_1',
      });

      expect(tx.sessionTurn.update).toHaveBeenCalledWith({
        where: { id: 'st_1' },
        data: expect.objectContaining({
          status: 'done',
          runningKey: null,
          engineMessageId: 'em_1',
        }),
      });
      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: 's_1' },
        data: { busyState: 'idle', busySince: null, lastTurnOutcome: 'ok' },
      });
      expect(result).toMatchObject({ status: 'done', outcome: 'ok' });
    });

    it('finish：超时/失败映射 timeout/error，保证后续消息能继续', async () => {
      tx.sessionTurn.findUnique.mockResolvedValue({
        id: 'st_2',
        sessionId: 's_1',
        status: 'running',
      });
      tx.sessionTurn.update.mockResolvedValue({});
      tx.session.update.mockResolvedValue({});

      const r1: any = await service().finish('st_2', 'expired');
      expect(r1.outcome).toBe('timeout');
      tx.sessionTurn.findUnique.mockResolvedValue({
        id: 'st_3',
        sessionId: 's_1',
        status: 'running',
      });
      const r2: any = await service().finish('st_3', 'failed', {
        error: 'boom',
      });
      expect(r2.outcome).toBe('error');
    });
  });
});
