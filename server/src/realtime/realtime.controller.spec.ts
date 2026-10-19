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
  REALTIME_LIVE_BUFFER_MAX_BYTES,
  REALTIME_LIVE_BUFFER_MAX_FRAMES,
  REALTIME_REPLAY_DEADLINE_MS,
} from './realtime.controller';
import {
  RealtimeEvent,
  RealtimeEventListener,
  RealtimeService,
  REALTIME_REPLAY_MAX,
} from './realtime.service';

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
      // 补拉按多 scope OR 查询（absent-since 仍解析最新游标 + take 硬上限）
      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { scopeType: 'channel', scopeId: 'c_1' },
            { scopeType: 'task', scopeId: 't_2' },
            { scopeType: 'global' },
          ],
        },
        orderBy: { id: 'asc' },
        take: REALTIME_REPLAY_MAX,
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
        orderBy: { id: 'desc' },
        take: REALTIME_REPLAY_MAX,
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
      // 显式游标路径降序取最新；mock 按 DB 降序返回，服务 reverse 成升序下发。
      prisma.realtimeEvent.findMany.mockResolvedValue([
        dbRow('ev_0000000004', 'd'),
        dbRow('ev_0000000003', 'c'),
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
      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { OR: [{ scopeType: 'global' }], id: { gt: 'ev_0000000002' } },
        orderBy: { id: 'desc' },
        take: REALTIME_REPLAY_MAX,
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

    it('since 未传时不再无界重放历史：解析最新 id 为游标（findMany 恒有 id 下界 + take）', async () => {
      grantAccess();
      prisma.realtimeEvent.findFirst.mockResolvedValue({ id: 'ev_0000000010' });
      prisma.realtimeEvent.findMany.mockResolvedValue([]);

      const obs = await controller.events(undefined, 'global', accessToken);
      await collectEvents(obs, 0);
      await new Promise((resolve) => setImmediate(resolve));

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { OR: [{ scopeType: 'global' }], id: { gt: 'ev_0000000010' } },
        orderBy: { id: 'asc' },
        take: REALTIME_REPLAY_MAX,
      });
    });
  });

  describe('补拉失败后重放期必须结束（incident-livebuffer-finally）', () => {
    it('getEventsSince 拒绝：replaying 复位为 false，后续实时帧直通而非继续进 liveBuffer', async () => {
      grantAccess();
      // 补拉查询直接拒绝（模拟 DB 故障 / 连接池耗尽）
      prisma.realtimeEvent.findMany.mockRejectedValue(new Error('db down'));

      let capturedListener: RealtimeEventListener | undefined;
      const subscribeSpy = jest
        .spyOn(realtime, 'subscribe')
        .mockImplementation((listener) => {
          capturedListener = listener;
          return () => {};
        });

      const obs = await controller.events(undefined, 'global', accessToken);
      // 订阅并等待补拉失败冒泡为 subscriber.error（与线上 catch 路径一致）
      await new Promise<void>((resolve) => {
        obs.subscribe({ next: () => {}, error: () => resolve() });
      });

      // 此刻补拉尝试已（以失败）结束：liveBuffer 必须已停止累积。
      // 直接驱动监听器推一帧实时事件：
      // - 有 finally：replaying=false → 帧走直通分支（toMessageEvent 被调用）
      // - 无 finally：replaying 仍为 true → 帧被静默推进 liveBuffer（toMessageEvent 不被调用）
      const toMessageEventSpy = jest.spyOn(
        controller as unknown as {
          toMessageEvent: (e: RealtimeEvent) => MessageEvent;
        },
        'toMessageEvent',
      );
      const liveFrame: RealtimeEvent = {
        id: 'ev_0000000009',
        type: 'chat.message.new',
        payload: { messageId: 'm_live' },
        timestamp: '2026-10-15T00:00:00.000Z',
        scopeType: 'global',
        scopeId: null,
      };
      capturedListener!(liveFrame);
      expect(toMessageEventSpy).toHaveBeenCalledWith(liveFrame);

      toMessageEventSpy.mockRestore();
      subscribeSpy.mockRestore();
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

  describe('续拉缓冲无界增长边界（incident-livebuffer-bound，Path F）', () => {
    /** 构造一帧实时事件（id 零填充对齐 ev_ 字典序）。 */
    const liveFrame = (
      seq: number,
      payload: unknown = { messageId: `m_${seq}` },
    ): RealtimeEvent => ({
      id: `ev_${String(seq).padStart(10, '0')}`,
      type: 'chat.message.new',
      payload,
      timestamp: '2026-10-15T00:00:00.000Z',
      scopeType: 'global',
      scopeId: null,
    });

    /** 过滤心跳帧只剩业务帧（死线与心跳可能同 tick 触发）。 */
    const ids = (events: MessageEvent[]) =>
      events.filter((e) => e.type !== 'heartbeat').map((e) => e.id);

    /** 捕获 subscribe 监听器 + 控制器 logger.warn（触顶/死线断言共用）。 */
    const capture = () => {
      let listener: RealtimeEventListener | undefined;
      const subscribeSpy = jest
        .spyOn(realtime, 'subscribe')
        .mockImplementation((l) => {
          listener = l;
          return () => {};
        });
      const warnSpy = jest
        .spyOn(
          (controller as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(() => {});
      return {
        emit: (event: RealtimeEvent) => listener!(event),
        warnSpy,
        restore: () => {
          subscribeSpy.mockRestore();
          warnSpy.mockRestore();
        },
      };
    };

    /** hung 补拉：latest 游标查询与 findMany 都永不 settle。 */
    const hangReplay = () => {
      prisma.realtimeEvent.findFirst.mockReturnValue(new Promise(() => {}));
      prisma.realtimeEvent.findMany.mockReturnValue(new Promise(() => {}));
    };

    it('补拉永不 settle：缓冲按条数上限收敛（淘汰最旧帧 + warn 可见），死线强制结束重放期并整体下发，此后实时帧直通', async () => {
      jest.useFakeTimers();
      const cap = capture();
      let subscription: Subscription;
      try {
        grantAccess();
        hangReplay();

        const received: MessageEvent[] = [];
        const obs = await controller.events(undefined, 'global', accessToken);
        subscription = obs.subscribe({
          next: (ev) => received.push(ev),
          error: () => {},
        });

        // 推进 3×cap+5 帧（远超上限）：死线未到 → replaying 仍为 true，
        // 全部进缓冲、无一被下发；缓冲收敛在 cap 而非无界增长。
        const pushed = REALTIME_LIVE_BUFFER_MAX_FRAMES * 3 + 5;
        for (let seq = 1; seq <= pushed; seq++) {
          cap.emit(liveFrame(seq));
        }
        expect(ids(received)).toEqual([]);
        // 触顶丢帧必须可见（非静默）：warn 一行
        expect(cap.warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[liveBuffer]'),
        );

        // 死线触发：缓冲被收敛到 cap（最旧 pushed-cap 帧已淘汰）后整体下发
        jest.advanceTimersByTime(REALTIME_REPLAY_DEADLINE_MS);
        const flushed = ids(received);
        expect(flushed).toHaveLength(REALTIME_LIVE_BUFFER_MAX_FRAMES);
        expect(flushed[0]).toBe(
          `ev_${String(pushed - REALTIME_LIVE_BUFFER_MAX_FRAMES + 1).padStart(10, '0')}`,
        );
        expect(flushed[flushed.length - 1]).toBe(
          `ev_${String(pushed).padStart(10, '0')}`,
        );
        // 死线释放同样可见
        expect(cap.warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('强制结束重放期'),
        );

        // 死线后：replaying=false → 实时帧直通，不再进缓冲
        cap.emit(liveFrame(pushed + 1));
        expect(ids(received)).toHaveLength(REALTIME_LIVE_BUFFER_MAX_FRAMES + 1);
        expect(ids(received)[REALTIME_LIVE_BUFFER_MAX_FRAMES]).toBe(
          `ev_${String(pushed + 1).padStart(10, '0')}`,
        );
      } finally {
        subscription.unsubscribe();
        cap.restore();
        jest.useRealTimers();
      }
    });

    it('补拉永不 settle：字节预算独立收敛大帧（条数上限远未达到，单帧 ~2MiB）', async () => {
      jest.useFakeTimers();
      const cap = capture();
      let subscription: Subscription;
      try {
        grantAccess();
        hangReplay();

        const received: MessageEvent[] = [];
        const obs = await controller.events(undefined, 'global', accessToken);
        subscription = obs.subscribe({
          next: (ev) => received.push(ev),
          error: () => {},
        });

        // 40 帧 × ~2MiB = ~80MiB：条数上限（1000）远未达到，只有字节预算能收敛。
        // 预算 64MiB ÷ (2MiB + 帧头) ≈ 31-32 帧保留（最旧帧淘汰，最新帧恒保留）。
        const twoMib = 'x'.repeat(2 * 1024 * 1024);
        const pushed = 40;
        for (let seq = 1; seq <= pushed; seq++) {
          cap.emit(liveFrame(seq, { big: twoMib }));
        }
        expect(ids(received)).toEqual([]);

        jest.advanceTimersByTime(REALTIME_REPLAY_DEADLINE_MS);
        const flushed = ids(received);
        expect(flushed.length).toBeGreaterThan(0);
        expect(flushed.length).toBeLessThanOrEqual(32);
        // 最新帧恒保留（淘汰只删头部）
        expect(flushed[flushed.length - 1]).toBe(
          `ev_${String(pushed).padStart(10, '0')}`,
        );
      } finally {
        subscription.unsubscribe();
        cap.restore();
        jest.useRealTimers();
      }
    });

    it('死线先释放、补拉随后才迟到：迟到 backlog 整体跳过（不重复下发已送达帧），后续广播走直通恰好一次', async () => {
      jest.useFakeTimers();
      const cap = capture();
      let subscription: Subscription;
      try {
        grantAccess();
        // latest 游标查询立即返回；findMany 悬挂，由测试手动 resolve（迟到 30s+）
        prisma.realtimeEvent.findFirst.mockResolvedValue({
          id: 'ev_0000000000',
        });
        let resolveReplay: (rows: unknown[]) => void = () => {};
        prisma.realtimeEvent.findMany.mockReturnValue(
          new Promise((resolve) => {
            resolveReplay = resolve as (rows: unknown[]) => void;
          }),
        );

        const received: MessageEvent[] = [];
        const obs = await controller.events(undefined, 'global', accessToken);
        subscription = obs.subscribe({
          next: (ev) => received.push(ev),
          error: () => {},
        });

        // 悬挂期间到达 5 帧 → 进缓冲；死线先释放：整体下发
        for (let seq = 1; seq <= 5; seq++) {
          cap.emit(liveFrame(seq));
        }
        jest.advanceTimersByTime(REALTIME_REPLAY_DEADLINE_MS);
        const expected = [
          'ev_0000000001',
          'ev_0000000002',
          'ev_0000000003',
          'ev_0000000004',
          'ev_0000000005',
        ];
        expect(ids(received)).toEqual(expected);

        // 补拉此刻才 settle：backlog 含已下发的 ev_3（重复）——必须整体跳过
        resolveReplay([dbRow('ev_0000000003', 'dup')]);
        for (let i = 0; i < 10; i++) {
          await Promise.resolve();
        }
        expect(ids(received)).toEqual(expected);

        // 现实中广播紧随 settle 续体的帧（如 ev_9）：走直通，恰好一次
        cap.emit(liveFrame(9));
        expect(ids(received)).toHaveLength(6);
        expect(ids(received)[5]).toBe('ev_0000000009');
      } finally {
        subscription.unsubscribe();
        cap.restore();
        jest.useRealTimers();
      }
    });

    it('正常补拉（毫秒级 settle）不受边界影响：backlog + 续拉缓冲按 id 去重下发，无 warn、死线不触发', async () => {
      const cap = capture();
      let subscription: Subscription;
      try {
        grantAccess();
        prisma.realtimeEvent.findMany.mockResolvedValue([
          dbRow('ev_0000000001', 'a'),
          dbRow('ev_0000000002', 'b'),
        ]);

        const received: MessageEvent[] = [];
        const obs = await controller.events(undefined, 'global', accessToken);
        subscription = obs.subscribe({
          next: (ev) => received.push(ev),
          error: () => {},
        });

        // 补拉 settle 前（同步窗口）到达的实时帧进缓冲：ev_2 与 backlog 重复、ev_3 新增
        cap.emit(liveFrame(2));
        cap.emit(liveFrame(3));
        await new Promise((resolve) => setImmediate(resolve));

        expect(ids(received)).toEqual([
          'ev_0000000001',
          'ev_0000000002',
          'ev_0000000003',
        ]);
        // 正常路径：触顶 warn 与死线 warn 都不得出现
        expect(cap.warnSpy).not.toHaveBeenCalled();
      } finally {
        subscription.unsubscribe();
        cap.restore();
      }
    });
  });
});
