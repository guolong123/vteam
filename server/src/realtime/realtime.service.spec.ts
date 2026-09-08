import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import {
  RealtimeService,
  RealtimeEvent,
  RealtimeScope,
} from './realtime.service';

describe('RealtimeService（内部事件总线 + 持久化）', () => {
  let service: RealtimeService;
  let prisma: {
    realtimeEvent: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
    };
    task: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    chatChannel: { findUnique: jest.Mock; findMany: jest.Mock };
    team: { findUnique: jest.Mock };
  };

  const row = (
    id: string,
    type: string,
    scopeType = 'global',
    scopeId: string | null = null,
    createdAt = new Date('2026-08-07T00:00:00.000Z'),
  ) => ({
    id,
    type,
    scopeType,
    scopeId,
    payload: { n: 1 },
    createdAt,
  });

  beforeEach(() => {
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
      task: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      chatChannel: { findUnique: jest.fn(), findMany: jest.fn() },
      team: { findUnique: jest.fn() },
    };
    service = new RealtimeService(
      prisma as unknown as PrismaService,
      new IdGeneratorService(),
    );
  });

  describe('emit / broadcast', () => {
    it('emit 返回完整事件帧 {id, type, payload, timestamp}，id 为字符串 ev_ 主键', async () => {
      const ev = await service.emit('chat.message.new', { messageId: 'm_1' });
      expect(ev).toMatchObject({
        id: 'ev_0000000001',
        type: 'chat.message.new',
        payload: { messageId: 'm_1' },
        scopeType: 'global',
        scopeId: null,
      });
      expect(ev.timestamp).toBeDefined();
      expect(new Date(ev.timestamp).toISOString()).toBe(ev.timestamp);
    });

    it('事件先落库后转发：create 先于订阅者收到事件', async () => {
      const received: RealtimeEvent[] = [];
      service.subscribe((e) => received.push(e));

      await service.emit('a', { n: 1 });

      expect(prisma.realtimeEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'ev_0000000001',
          type: 'a',
          scopeType: 'global',
          scopeId: null,
        }),
      });
      expect(received).toHaveLength(1);
    });

    it('事件落库不再写 project 维度字段（列删除前置）', async () => {
      await service.emit('a', { n: 1 }, { type: 'task', id: 't_1' });
      const data = prisma.realtimeEvent.create.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect('projectId' in data).toBe(false);
    });

    it('事件帧不携带 project 维度字段', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      const ev = await service.emit('a', { n: 1 }, { type: 'task', id: 't_1' });
      expect('projectId' in ev).toBe(false);
    });

    it('事件 id 单调递增（字符串 ev_<零填充序号>，数值序 == 字典序）', async () => {
      const first = await service.emit('a', { n: 1 });
      const second = await service.emit('b', { n: 2 });
      const third = await service.emit('c', { n: 3 });
      expect(first.id).toBe('ev_0000000001');
      expect(second.id).toBe('ev_0000000002');
      expect(third.id).toBe('ev_0000000003');
      expect(second.id > first.id).toBe(true);
      expect(third.id > second.id).toBe(true);
    });

    it('is_0000000040：P2002 PRIMARY 冲突 → reseed DB max → 重新生成 id 重试成功', async () => {
      // 首次 create 抛 P2002（PRIMARY 主键冲突，多实例并存窗口），
      // findFirst 返回当前 DB 最大 ev_ 序号（另一实例已用）→ reseed 后重试成功
      prisma.realtimeEvent.create
        .mockRejectedValueOnce({
          code: 'P2002',
          meta: { target: ['PRIMARY'] },
        })
        .mockImplementation((args) =>
          Promise.resolve({
            id: args.data.id,
            type: args.data.type,
            scopeType: args.data.scopeType,
            scopeId: args.data.scopeId,
            payload: args.data.payload,
            createdAt: new Date(),
          }),
        );
      prisma.realtimeEvent.findFirst.mockResolvedValue({ id: 'ev_0000000009' });

      const ev = await service.emit('chat.message.new', { messageId: 'm_1' });

      // 重试后 id 跳过冲突序号（reseed 到 9 → nextId 10）
      expect(ev.id).toBe('ev_0000000010');
      expect(prisma.realtimeEvent.create).toHaveBeenCalledTimes(2);
      expect(prisma.realtimeEvent.findFirst).toHaveBeenCalled();
    });

    it('is_0000000040：非 PRIMARY 的 P2002（业务唯一约束）不重试，原样上抛', async () => {
      prisma.realtimeEvent.create.mockRejectedValueOnce({
        code: 'P2002',
        meta: { target: ['uk_something_else'] },
      });

      await expect(service.emit('a', { n: 1 })).rejects.toMatchObject({
        code: 'P2002',
      });
      expect(prisma.realtimeEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.realtimeEvent.findFirst).not.toHaveBeenCalled();
    });

    it('is_0000000040：P2002 重试超限（3 次仍冲突）→ 上抛异常（不无限循环）', async () => {
      prisma.realtimeEvent.create.mockRejectedValue({
        code: 'P2002',
        meta: { target: ['PRIMARY'] },
      });
      prisma.realtimeEvent.findFirst.mockResolvedValue({ id: 'ev_0000000005' });

      await expect(service.emit('a', { n: 1 })).rejects.toMatchObject({
        code: 'P2002',
      });
      // 初始 + 3 次重试 = 4 次 create 调用
      expect(prisma.realtimeEvent.create).toHaveBeenCalledTimes(4);
    });

    it('broadcast 是 emit 的语义别名，返回同构事件帧', async () => {
      const ev = await service.broadcast('task.status.changed', {
        taskId: 't_1',
      });
      expect(ev.id).toBe('ev_0000000001');
      expect(ev.type).toBe('task.status.changed');
      expect(service.getLatestId()).toBe('ev_0000000001');
    });

    it('emit 携带 scope 时写入 scope_type / scope_id', async () => {
      const ev = await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      expect(ev.scopeType).toBe('task');
      expect(ev.scopeId).toBe('t_1');
      expect(prisma.realtimeEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scopeType: 'task',
          scopeId: 't_1',
        }),
      });
    });
  });

  describe('emit 解析 teamId（scope=all 团队可见性依据）', () => {
    it('task scope → 查 tasks.teamId 写入内存 teamId', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });

      const ev = await service.emit(
        'team.changed',
        { taskId: 't_1' },
        { type: 'task', id: 't_1' },
      );

      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 't_1' },
        select: { teamId: true },
      });
      expect(ev.teamId).toBe('tm_1');
    });

    it('channel scope 团队频道 → 直接取 chat_channels.teamId', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        taskId: null,
        teamId: 'tm_1',
      });

      const ev = await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'channel', id: 'c_1' },
      );

      expect(prisma.chatChannel.findUnique).toHaveBeenCalledWith({
        where: { id: 'c_1' },
        select: { taskId: true, teamId: true },
      });
      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      expect(ev.teamId).toBe('tm_1');
    });

    it('channel scope 任务频道 → 经 channel.taskId 回退查 tasks.teamId', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        taskId: 't_1',
        teamId: null,
      });
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_9' });

      const ev = await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'channel', id: 'c_1' },
      );

      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 't_1' },
        select: { teamId: true },
      });
      expect(ev.teamId).toBe('tm_9');
    });

    it('team scope → scopeId 即团队 id（不查库）', async () => {
      const ev = await service.emit(
        'team.changed',
        { teamId: 'tm_1' },
        { type: 'team', id: 'tm_1' },
      );
      expect(ev.teamId).toBe('tm_1');
      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      expect(prisma.chatChannel.findUnique).not.toHaveBeenCalled();
    });

    it('global scope → 从 payload.taskId 反查 tasks.teamId', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });

      const ev = await service.emit('task.status.changed', {
        taskId: 't_1',
      });

      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 't_1' },
        select: { teamId: true },
      });
      expect(ev.teamId).toBe('tm_1');
    });

    it('global scope payload 无 taskId → teamId 为 null（不查库）', async () => {
      const ev = await service.emit('team.changed', { teamId: 'tm_1' });

      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      expect(ev.teamId).toBeNull();
    });

    it('解析目标不存在 → teamId 为 null（事件照常落库转发）', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      prisma.chatChannel.findUnique.mockResolvedValue(null);

      const evTask = await service.emit('a', {}, { type: 'task', id: 't_x' });
      expect(evTask.teamId).toBeNull();
      const evChannel = await service.emit(
        'b',
        {},
        { type: 'channel', id: 'c_x' },
      );
      expect(evChannel.teamId).toBeNull();
      // 落库调用本身未中断
      expect(prisma.realtimeEvent.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('subscribe（实时订阅 + scope 过滤）', () => {
    it('无 scope 订阅者收到全部广播事件', async () => {
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe((e) => received.push(e));

      await service.broadcast('artifact.submitted', { artifactId: 'a_1' });
      await service.broadcast('agent.loading', { agentId: 'ag_1' });

      expect(received).toHaveLength(2);
      expect(received[0].type).toBe('artifact.submitted');
      expect(received[1].type).toBe('agent.loading');
      unsubscribe();
    });

    it('带 scope 订阅仅收到匹配 scope 的事件（task:<id>）', async () => {
      const received: RealtimeEvent[] = [];
      const scope: RealtimeScope = { type: 'task', id: 't_1' };
      const unsubscribe = service.subscribe((e) => received.push(e), scope);

      await service.broadcast(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      await service.broadcast(
        'chat.message.new',
        { messageId: 'm_2' },
        { type: 'task', id: 't_2' },
      );
      await service.broadcast('team.changed', { teamId: 'tm_1' }); // global

      expect(received).toHaveLength(1);
      expect((received[0].payload as { messageId: string }).messageId).toBe(
        'm_1',
      );
      unsubscribe();
    });

    it('global 订阅仅收到全局事件（不匹配 task/channel 事件）', async () => {
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe((e) => received.push(e), {
        type: 'global',
      });

      await service.broadcast('team.changed', { teamId: 'tm_1' }); // global
      await service.broadcast(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'channel', id: 'c_1' },
      );

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('team.changed');
      unsubscribe();
    });

    it('多 scope 数组订阅命中任一 scope 即转发', async () => {
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        [
          { type: 'task', id: 't_1' },
          { type: 'channel', id: 'c_1' },
        ],
      );

      await service.broadcast(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      await service.broadcast(
        'chat.message.new',
        { messageId: 'm_2' },
        { type: 'channel', id: 'c_1' },
      );
      await service.broadcast(
        'chat.message.new',
        { messageId: 'm_3' },
        { type: 'task', id: 't_2' },
      );
      await service.broadcast('team.changed', { teamId: 'tm_1' }); // global

      expect(
        received.map((e) => (e.payload as { messageId: string }).messageId),
      ).toEqual(['m_1', 'm_2']);
      unsubscribe();
    });

    it('unsubscribe 后不再收到事件', async () => {
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe((e) => received.push(e));
      unsubscribe();
      await service.broadcast('chat.message.new', {});
      expect(received).toHaveLength(0);
    });

    it('带 visibleTeamIds 仅转发命中可见团队的事件（团队成员收到本团队 task/channel/team 事件）', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.chatChannel.findUnique.mockResolvedValue({
        taskId: null,
        teamId: 'tm_1',
      });
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        ['tm_1'],
      );

      await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      ); // teamId tm_1 → 命中
      await service.emit(
        'chat.message.new',
        { messageId: 'm_2' },
        { type: 'channel', id: 'c_1' },
      ); // teamId tm_1 → 命中
      await service.emit(
        'team.changed',
        { teamId: 'tm_1' },
        { type: 'team', id: 'tm_1' },
      ); // teamId tm_1 → 命中

      expect(
        received.map((e) => (e.payload as { messageId: string }).messageId),
      ).toEqual(['m_1', 'm_2']);
      expect(received).toHaveLength(3);
      unsubscribe();
    });

    it('伪造他团队 scope 订阅无事件（visibleTeamIds=[tm_other] 收不到 tm_1 事件）', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.chatChannel.findUnique.mockResolvedValue({
        taskId: null,
        teamId: 'tm_1',
      });
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        ['tm_other'],
      );

      await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      await service.emit(
        'chat.message.new',
        { message: { channelId: 'c_1' } },
        { type: 'channel', id: 'c_1' },
      );
      await service.emit(
        'team.changed',
        { teamId: 'tm_1' },
        { type: 'team', id: 'tm_1' },
      );

      expect(received).toHaveLength(0);
      unsubscribe();
    });

    it('teamId 为 null 的事件不进团队可见流（防止兜底泄露）', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        ['tm_1'],
      );

      await service.broadcast('team.changed', { teamId: 'tm_1' }); // global 无 taskId → teamId null

      expect(received).toHaveLength(0);
      unsubscribe();
    });

    it('visibleTeamIds 为 null 时不过滤（保持既有订阅行为）', async () => {
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        null,
      );

      await service.broadcast('a', { n: 1 });
      expect(received).toHaveLength(1);
      unsubscribe();
    });

    it('visibleTeamIds 显式空数组时任何事件都不放行（无可见团队防泄露）', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        [],
      );

      await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      await service.broadcast('team.changed', { teamId: 'tm_1' });

      expect(received).toHaveLength(0);
      unsubscribe();
    });

    it('零任务团队频道：团队成员经 teamId 放行 channel + team 广播', async () => {
      // 频道归属 tm_1 且无任务分区
      prisma.chatChannel.findUnique.mockResolvedValue({
        teamId: 'tm_1',
        taskId: null,
      });
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        ['tm_1'],
      );

      const ch = await service.emit(
        'chat.message.new',
        { message: { channelId: 'c_1' } },
        { type: 'channel', id: 'c_1' },
      );
      const tm = await service.emit(
        'chat.message.new',
        { message: { channelId: 'c_1' } },
        { type: 'team', id: 'tm_1' },
      );

      expect(ch.teamId).toBe('tm_1');
      expect(tm.teamId).toBe('tm_1');
      expect(received.map((e) => e.id)).toEqual([ch.id, tm.id]);
      unsubscribe();
    });

    it('零任务团队频道：非成员收不到（团队未命中）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        teamId: 'tm_1',
        taskId: null,
      });
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        ['tm_other'],
      );

      await service.emit(
        'chat.message.new',
        { message: { channelId: 'c_1' } },
        { type: 'channel', id: 'c_1' },
      );
      await service.emit(
        'chat.message.new',
        { message: { channelId: 'c_1' } },
        { type: 'team', id: 'tm_1' },
      );

      expect(received).toHaveLength(0);
      unsubscribe();
    });
  });

  describe('getEventsSince（DB 补拉，断线续拉）', () => {
    it('以 DB 为准返回 id 大于 since 的历史事件', async () => {
      prisma.realtimeEvent.findMany.mockResolvedValue([
        row('ev_0000000003', 'c'),
      ]);

      const events = await service.getEventsSince('ev_0000000002');

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { id: { gt: 'ev_0000000002' } },
        orderBy: { id: 'asc' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('ev_0000000003');
      expect(events[0].scopeType).toBe('global');
    });

    it('since 未指定时返回 scope 下全部事件（全新连接）', async () => {
      prisma.realtimeEvent.findMany.mockResolvedValue([
        row('ev_0000000001', 'a'),
        row('ev_0000000002', 'b'),
      ]);

      const events = await service.getEventsSince();

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { id: 'asc' },
      });
      expect(events.map((e) => e.id)).toEqual([
        'ev_0000000001',
        'ev_0000000002',
      ]);
    });

    it('带 scope 时按 scope_type + scope_id 过滤 DB 查询', async () => {
      const events = await service.getEventsSince(undefined, {
        type: 'task',
        id: 't_1',
      });

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { OR: [{ scopeType: 'task', scopeId: 't_1' }] },
        orderBy: { id: 'asc' },
      });
      expect(events).toEqual([]);
    });

    it('全局 scope 时仅取 global 事件', async () => {
      await service.getEventsSince('ev_0000000001', { type: 'global' });

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { OR: [{ scopeType: 'global' }], id: { gt: 'ev_0000000001' } },
        orderBy: { id: 'asc' },
      });
    });

    it('多 scope 以 OR 组合 DB 查询（task + global 混用）', async () => {
      const events = await service.getEventsSince('ev_0000000001', [
        { type: 'task', id: 't_1' },
        { type: 'global' },
      ]);

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ scopeType: 'task', scopeId: 't_1' }, { scopeType: 'global' }],
          id: { gt: 'ev_0000000001' },
        },
        orderBy: { id: 'asc' },
      });
      expect(events).toEqual([]);
    });

    it('visibleTeamIds 为 null 时不过滤（保持既有查询行为）', async () => {
      await service.getEventsSince('ev_0000000001', { type: 'global' }, null);

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { OR: [{ scopeType: 'global' }], id: { gt: 'ev_0000000001' } },
        orderBy: { id: 'asc' },
      });
    });

    it('visibleTeamIds 非空时按团队归属过滤：成员补拉本团队事件，非成员仍过滤', async () => {
      const chRow = row('ev_0000000002', 'chat.message.new', 'channel', 'c_1');
      const tmRow = row('ev_0000000003', 'chat.message.new', 'team', 'tm_1');
      const otherRow = row(
        'ev_0000000004',
        'chat.message.new',
        'team',
        'tm_other',
      );
      prisma.realtimeEvent.findMany.mockResolvedValue([chRow, tmRow, otherRow]);
      prisma.chatChannel.findMany.mockResolvedValue([
        { id: 'c_1', teamId: 'tm_1' },
      ]);

      const member = await service.getEventsSince('ev_0000000001', undefined, [
        'tm_1',
      ]);
      expect(member.map((e) => e.id)).toEqual([
        'ev_0000000002',
        'ev_0000000003',
      ]);

      prisma.realtimeEvent.findMany.mockResolvedValue([chRow, tmRow, otherRow]);
      const stranger = await service.getEventsSince(
        'ev_0000000001',
        undefined,
        ['tm_other'],
      );
      expect(stranger.map((e) => e.id)).toEqual(['ev_0000000004']);
    });

    it('visibleTeamIds 显式空数组时补拉返回空集（无可见团队防泄露）', async () => {
      prisma.realtimeEvent.findMany.mockResolvedValue([
        row('ev_0000000002', 'chat.message.new', 'team', 'tm_1'),
      ]);

      const events = await service.getEventsSince(
        'ev_0000000001',
        undefined,
        [],
      );
      expect(events).toEqual([]);
    });

    it('since=latest 时以最新已落库事件 id 为游标，仅返回其后新事件（首连跳过历史）', async () => {
      prisma.realtimeEvent.findFirst.mockResolvedValue({ id: 'ev_0000000004' });
      prisma.realtimeEvent.findMany.mockResolvedValue([
        row('ev_0000000005', 'task.status.changed'),
      ]);

      const events = await service.getEventsSince('latest');

      expect(prisma.realtimeEvent.findFirst).toHaveBeenCalledWith({
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { id: { gt: 'ev_0000000004' } },
        orderBy: { id: 'asc' },
      });
      expect(events.map((e) => e.id)).toEqual(['ev_0000000005']);
    });

    it('since=latest 且库空时不过滤 DB 查询（findMany 自然返回空）', async () => {
      prisma.realtimeEvent.findFirst.mockResolvedValue(null);

      const events = await service.getEventsSince('latest');

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { id: 'asc' },
      });
      expect(events).toEqual([]);
    });

    it('DB 行映射为事件帧：createdAt → ISO8601 timestamp（无 project 维度字段）', async () => {
      prisma.realtimeEvent.findMany.mockResolvedValue([
        row(
          'ev_0000000005',
          'task.status.changed',
          'task',
          't_9',
          new Date('2026-08-07T01:02:03.000Z'),
        ),
      ]);

      const events = await service.getEventsSince();
      expect(events[0]).toEqual({
        id: 'ev_0000000005',
        type: 'task.status.changed',
        payload: { n: 1 },
        timestamp: '2026-08-07T01:02:03.000Z',
        scopeType: 'task',
        scopeId: 't_9',
      });
      expect('projectId' in events[0]).toBe(false);
    });
  });

  describe('onModuleInit / getLatestId', () => {
    it('启动时以库内最大 ev_ id 对齐序号（重启续号）', async () => {
      prisma.realtimeEvent.findFirst.mockResolvedValue({ id: 'ev_0000000042' });
      await service.onModuleInit();

      const ev = await service.emit('a', {});
      expect(ev.id).toBe('ev_0000000043');
    });

    it('库内无事件时从 ev_0000000001 起号', async () => {
      prisma.realtimeEvent.findFirst.mockResolvedValue(null);
      await service.onModuleInit();

      const ev = await service.emit('a', {});
      expect(ev.id).toBe('ev_0000000001');
    });

    it('getLatestId 与最新事件 id 一致（游标同源语义）', async () => {
      await service.broadcast('a', { n: 1 });
      await service.broadcast('b', { n: 2 });
      expect(service.getLatestId()).toBe('ev_0000000002');
    });
  });
});
