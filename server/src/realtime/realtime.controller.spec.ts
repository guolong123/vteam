import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  MessageEvent,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable, Subscription } from 'rxjs';
import { IdGeneratorService } from '../common/id-generator';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  RealtimeController,
  HEARTBEAT_INTERVAL_MS,
} from './realtime.controller';
import { RealtimeService } from './realtime.service';

describe('RealtimeController（SSE 端点）', () => {
  let controller: RealtimeController;
  let realtime: RealtimeService;
  let prisma: {
    realtimeEvent: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
    };
    task: { findUnique: jest.Mock; findMany: jest.Mock };
    chatChannel: { findUnique: jest.Mock; findMany: jest.Mock };
    teamUserMember: { findUnique: jest.Mock; findMany: jest.Mock };
  };
  let jwt: { verifyAsync: jest.Mock };

  const accessToken = 'jwt-access-token';

  const dbRow = (
    id: string,
    type: string,
    scopeType = 'global',
    scopeId: string | null = null,
  ) => ({
    id,
    type,
    scopeType,
    scopeId,
    payload: { n: 1 },
    createdAt: new Date('2026-08-07T00:00:00.000Z'),
  });

  beforeEach(async () => {
    prisma = {
      realtimeEvent: {
        findFirst: jest.fn(),
        create: jest.fn().mockImplementation((args) =>
          Promise.resolve({
            id: args.data.id,
            type: args.data.type,
            scopeType: args.data.scopeType,
            scopeId: args.data.scopeId,
            payload: args.data.payload,
            createdAt: new Date(),
          }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
      task: { findUnique: jest.fn(), findMany: jest.fn() },
      chatChannel: { findUnique: jest.fn(), findMany: jest.fn() },
      teamUserMember: { findUnique: jest.fn(), findMany: jest.fn() },
    };
    jwt = { verifyAsync: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RealtimeController],
      providers: [
        RealtimeService,
        IdGeneratorService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    controller = module.get<RealtimeController>(RealtimeController);
    realtime = module.get<RealtimeService>(RealtimeService);
  });

  /** 鉴权通过：mock JwtService.verifyAsync 返回 access payload。 */
  const grantAccess = () =>
    jwt.verifyAsync.mockResolvedValue({
      sub: 'u_admin',
      username: 'admin',
      roleId: 'r_admin',
      type: 'access',
    });

  /** 订阅 SSE Observable，收集到指定数量事件后断开（兼容同步回放）。 */
  function collectEvents(
    obs: Observable<MessageEvent>,
    count: number,
  ): Promise<MessageEvent[]> {
    return new Promise((resolve) => {
      const collected: MessageEvent[] = [];
      const subscription = new Subscription();
      const handler = (ev: MessageEvent) => {
        collected.push(ev);
        if (collected.length >= count) {
          subscription.unsubscribe();
          resolve(collected);
        }
      };
      subscription.add(obs.subscribe(handler));
      if (count === 0) {
        subscription.unsubscribe();
        resolve(collected);
      }
    });
  }

  /** 断言 403 响应码为 PERMISSION_TEAM_NOT_MEMBER。 */
  async function expectTeamForbidden(promise: Promise<unknown>) {
    try {
      await promise;
      throw new Error('expected ForbiddenException, but resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const res = (err as ForbiddenException).getResponse() as {
        code: string;
      };
      expect(res.code).toBe(TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER);
      expect(TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER).toBe(
        'PERMISSION_TEAM_NOT_MEMBER',
      );
    }
  }

  describe('query token 鉴权', () => {
    it('缺少 token → 401 AUTH_UNAUTHORIZED', async () => {
      await expect(controller.events()).rejects.toThrow(UnauthorizedException);
    });

    it('token 无效（解析失败）→ 401 AUTH_UNAUTHORIZED', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('jwt expired'));
      await expect(
        controller.events(undefined, 'global', 'bad-token'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('refresh token → 401 AUTH_UNAUTHORIZED（仅 access 可订阅）', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: 'u_admin', type: 'refresh' });
      await expect(
        controller.events(undefined, 'global', accessToken),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('scope 权限校验（团队成员链）', () => {
    it('scope=task:<id> 非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      grantAccess();
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expectTeamForbidden(
        controller.events(undefined, 'task:t_1', accessToken),
      );
      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'tm_1', userId: 'u_admin' } },
        select: { id: true },
      });
    });

    it('scope=task:<id> 任务不存在 → 403（防信息泄露）', async () => {
      grantAccess();
      prisma.task.findUnique.mockResolvedValue(null);

      await expectTeamForbidden(
        controller.events(undefined, 'task:t_missing', accessToken),
      );
    });

    it('scope=channel:<id> 非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      grantAccess();
      prisma.chatChannel.findUnique.mockResolvedValue({
        taskId: null,
        teamId: 'tm_1',
      });
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expectTeamForbidden(
        controller.events(undefined, 'channel:c_1', accessToken),
      );
    });

    it('scope=channel:<id> 频道不存在 → 403', async () => {
      grantAccess();
      prisma.chatChannel.findUnique.mockResolvedValue(null);

      await expectTeamForbidden(
        controller.events(undefined, 'channel:c_missing', accessToken),
      );
    });

    it('scope=team:<id> 非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      grantAccess();
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expectTeamForbidden(
        controller.events(undefined, 'team:tm_1', accessToken),
      );
      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'tm_1', userId: 'u_admin' } },
        select: { id: true },
      });
    });

    it('scope 格式非法（无 : 分隔）→ 400 SCOPE_INVALID', async () => {
      grantAccess();
      await expect(
        controller.events(undefined, 'foo', accessToken),
      ).rejects.toThrow(BadRequestException);
    });

    it('scope=task:<id> 为团队成员 → 放行并收到该 task 事件', async () => {
      grantAccess();
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });

      const obs = await controller.events(undefined, 'task:t_1', accessToken);
      const eventsPromise = collectEvents(obs, 1);
      await realtime.broadcast(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      const events = await eventsPromise;
      expect(events).toHaveLength(1);
      // 业务 type 在 data JSON 内（MessageEvent 不设 type → SSE 帧按 message 派发）
      expect((events[0].data as { type: string }).type).toBe(
        'chat.message.new',
      );
      expect(events[0].id).toBe('ev_0000000001');
    });

    it('scope=team:<id> 为团队成员 → 放行并收到该 team 事件', async () => {
      grantAccess();
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });

      const obs = await controller.events(undefined, 'team:tm_1', accessToken);
      const eventsPromise = collectEvents(obs, 1);
      await realtime.broadcast(
        'team.changed',
        { teamId: 'tm_1' },
        { type: 'team', id: 'tm_1' },
      );
      const events = await eventsPromise;
      expect(events).toHaveLength(1);
    });

    it('逗号分隔多 scope：逐 scope 校验团队成员，命中任一 scope 即推送', async () => {
      grantAccess();
      // channel:c_1 → tm_1；task:t_2 → tm_1；global 跳过校验
      prisma.chatChannel.findUnique.mockResolvedValue({
        taskId: null,
        teamId: 'tm_1',
      });
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });

      const obs = await controller.events(
        undefined,
        'channel:c_1,task:t_2,global',
        accessToken,
      );
      const eventsPromise = collectEvents(obs, 2);
      await realtime.broadcast(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'channel', id: 'c_1' },
      );
      await realtime.broadcast(
        'chat.message.new',
        { messageId: 'm_2' },
        { type: 'task', id: 't_2' },
      );
      await realtime.broadcast(
        'chat.message.new',
        { messageId: 'm_3' },
        { type: 'task', id: 't_other' },
      );
      const events = await eventsPromise;
      expect(
        events.map(
          (e) =>
            (e.data as { payload: { messageId: string } }).payload.messageId,
        ),
      ).toEqual(['m_1', 'm_2']);
      // 补拉按多 scope OR 查询
      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { scopeType: 'channel', scopeId: 'c_1' },
            { scopeType: 'task', scopeId: 't_2' },
            { scopeType: 'global' },
          ],
        },
        orderBy: { id: 'asc' },
      });
    });

    it('逗号分隔多 scope 中任一段无权限 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      grantAccess();
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      // 第一次校验 task:t_1 放行；第二次校验 task:t_9 无权限 → 整体 403
      prisma.teamUserMember.findUnique
        .mockResolvedValueOnce({ id: 'tum_1' })
        .mockResolvedValueOnce(null);

      await expectTeamForbidden(
        controller.events(undefined, 'task:t_1,task:t_9', accessToken),
      );
    });
  });

  describe('scope=all 全量订阅（按成员团队过滤）', () => {
    it('scope=all 放行：可见团队 = 调用者全部成员团队，实时只收成员团队事件', async () => {
      grantAccess();
      // 调用者成员团队 tm_1（teamUserMember.findMany 全量查）
      prisma.teamUserMember.findMany.mockResolvedValue([{ teamId: 'tm_1' }]);
      // emit 解析 teamId：t_1 → tm_1（命中）、t_2 → tm_9（非成员团队）
      prisma.task.findUnique.mockResolvedValueOnce({ teamId: 'tm_1' });
      prisma.task.findUnique.mockResolvedValueOnce({ teamId: 'tm_9' });

      const obs = await controller.events(undefined, 'all', accessToken);
      const eventsPromise = collectEvents(obs, 1);
      await realtime.broadcast(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      await realtime.broadcast(
        'chat.message.new',
        { messageId: 'm_2' },
        { type: 'task', id: 't_2' },
      );
      const events = await eventsPromise;

      expect(prisma.teamUserMember.findMany).toHaveBeenCalledWith({
        where: { userId: 'u_admin' },
        select: { teamId: true },
      });
      expect(
        events.map(
          (e) =>
            (e.data as { payload: { messageId: string } }).payload.messageId,
        ),
      ).toEqual(['m_1']);
    });

    it('scope=all 补拉按团队归属过滤（成员只收本团队事件，含 since 叠加）', async () => {
      grantAccess();
      prisma.teamUserMember.findMany.mockResolvedValue([{ teamId: 'tm_1' }]);
      prisma.realtimeEvent.findMany.mockResolvedValue([
        dbRow('ev_0000000003', 'c', 'task', 't_1'),
      ]);
      prisma.task.findMany.mockResolvedValue([{ id: 't_1', teamId: 'tm_1' }]);

      const obs = await controller.events('ev_0000000002', 'all', accessToken);
      const events = await collectEvents(obs, 1);

      expect(events).toHaveLength(1);
      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: {
          id: { gt: 'ev_0000000002' },
        },
        orderBy: { id: 'asc' },
      });
    });

    it('无成员团队时 scope=all 收不到任何事件', async () => {
      grantAccess();
      prisma.teamUserMember.findMany.mockResolvedValue([]);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });

      const obs = await controller.events(undefined, 'all', accessToken);
      const eventsPromise = collectEvents(obs, 0);
      await realtime.broadcast(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      await realtime.broadcast('team.changed', { taskId: 't_1' }); // global teamId tm_1 也拦截
      const events = await eventsPromise;

      expect(events).toHaveLength(0);
    });

    it('scope=all 团队成员实时收到零任务团队频道的消息事件（团队维度放行）', async () => {
      grantAccess();
      prisma.teamUserMember.findMany.mockResolvedValue([{ teamId: 'tm_1' }]);
      // 频道归属 tm_1 且无任务分区；团队无 currentTask（toMessageDto 亦无 taskId）
      prisma.chatChannel.findUnique.mockResolvedValue({
        teamId: 'tm_1',
        taskId: null,
      });

      const obs = await controller.events(undefined, 'all', accessToken);
      expect(prisma.teamUserMember.findMany).toHaveBeenCalledWith({
        where: { userId: 'u_admin' },
        select: { teamId: true },
      });
      const eventsPromise = collectEvents(obs, 1);
      await realtime.broadcast(
        'chat.message.new',
        { message: { channelId: 'c_1' } },
        { type: 'channel', id: 'c_1' },
      );
      const events = await eventsPromise;

      expect(events).toHaveLength(1);
      expect((events[0].data as { type: string }).type).toBe(
        'chat.message.new',
      );
    });

    it('scope=all 伪造他团队 scope 订阅无事件（非团队成员收不到）', async () => {
      grantAccess();
      prisma.teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_other' },
      ]);
      prisma.chatChannel.findUnique.mockResolvedValue({
        teamId: 'tm_1',
        taskId: null,
      });

      const obs = await controller.events(undefined, 'all', accessToken);
      const eventsPromise = collectEvents(obs, 0);
      await realtime.broadcast(
        'chat.message.new',
        { message: { channelId: 'c_1' } },
        { type: 'channel', id: 'c_1' },
      );
      await realtime.broadcast(
        'chat.message.new',
        { message: { channelId: 'c_1' } },
        { type: 'team', id: 'tm_1' },
      );
      const events = await eventsPromise;

      expect(events).toHaveLength(0);
    });
  });

  describe('SSE 连接建立', () => {
    it('global 连接（无 since）收到已广播的存量事件（DB 补拉）', async () => {
      grantAccess();
      prisma.realtimeEvent.findMany.mockResolvedValue([
        dbRow('ev_0000000001', 'task.status.changed'),
      ]);

      const obs = await controller.events(undefined, 'global', accessToken);
      const events = await collectEvents(obs, 1);
      expect(events).toHaveLength(1);
      expect((events[0].data as { type: string }).type).toBe(
        'task.status.changed',
      );
      // MessageEvent.id 为字符串游标，供 EventSource lastEventId 续拉
      expect(events[0].id).toBe('ev_0000000001');
      const data = events[0].data as {
        id: string;
        type: string;
        payload: unknown;
        timestamp: string;
      };
      expect(data).toMatchObject({
        id: 'ev_0000000001',
        type: 'task.status.changed',
        payload: { n: 1 },
      });
      expect(data.timestamp).toBeDefined();
      // SSE 帧不含 scope 元数据（帧契约 {id, type, payload, timestamp}）
      expect(data).not.toHaveProperty('scopeType');
    });

    it('实时广播：连接后新事件被推送', async () => {
      grantAccess();
      const obs = await controller.events(undefined, 'global', accessToken);
      const eventsPromise = collectEvents(obs, 1);
      await realtime.broadcast('chat.message.new', { messageId: 'm_1' });
      const events = await eventsPromise;
      expect((events[0].data as { type: string }).type).toBe(
        'chat.message.new',
      );
      expect(events[0].id).toBe('ev_0000000001');
    });
  });

  describe('since 断线续拉（DB 为准）', () => {
    it('since=ev_0000000002 时仅返回 id>2 的遗漏事件', async () => {
      grantAccess();
      prisma.realtimeEvent.findMany.mockResolvedValue([
        dbRow('ev_0000000003', 'c'),
        dbRow('ev_0000000004', 'd'),
      ]);

      const obs = await controller.events(
        'ev_0000000002',
        'global',
        accessToken,
      );
      const events = await collectEvents(obs, 2);
      expect(events.map((e) => e.id)).toEqual([
        'ev_0000000003',
        'ev_0000000004',
      ]);
      expect((events[0].data as { type: string }).type).toBe('c');
      expect((events[1].data as { type: string }).type).toBe('d');
      // 查询按 scope + since 过滤
      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { OR: [{ scopeType: 'global' }], id: { gt: 'ev_0000000002' } },
        orderBy: { id: 'asc' },
      });
    });

    it('无遗漏事件时 since 续拉返回空流（仅心跳后续）', async () => {
      grantAccess();
      const obs = await controller.events(
        'ev_0000000001',
        'global',
        accessToken,
      );
      const events = await collectEvents(obs, 0);
      expect(events).toHaveLength(0);
    });

    it('since 未传时返回全部存量事件（全新连接）', async () => {
      grantAccess();
      prisma.realtimeEvent.findMany.mockResolvedValue([
        dbRow('ev_0000000001', 'a'),
        dbRow('ev_0000000002', 'b'),
      ]);

      const obs = await controller.events(undefined, 'global', accessToken);
      const events = await collectEvents(obs, 2);
      expect(events.map((e) => e.id)).toEqual([
        'ev_0000000001',
        'ev_0000000002',
      ]);
    });
  });

  describe('心跳保活', () => {
    it('每 15s 发送 heartbeat 事件', async () => {
      jest.useFakeTimers();
      try {
        grantAccess();
        const obs = await controller.events(undefined, 'global', accessToken);
        const eventsPromise = collectEvents(obs, 1);
        jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        const events = await eventsPromise;
        expect(events[0].type).toBe('heartbeat');
        const data = events[0].data as { type: string; payload: null };
        expect(data).toMatchObject({ type: 'heartbeat', payload: null });
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
