import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService, RealtimeEvent, RealtimeScope } from './realtime.service';

describe('RealtimeService（内部事件总线 + 持久化）', () => {
  let service: RealtimeService;
  let prisma: {
    realtimeEvent: {
      findFirst: jest.Mock;
      create: jest.Mock;
      findMany: jest.Mock;
    };
    task: { findUnique: jest.Mock };
    chatChannel: { findUnique: jest.Mock };
  };

  const row = (
    id: string,
    type: string,
    scopeType = 'global',
    scopeId: string | null = null,
    projectId: string | null = null,
    createdAt = new Date('2026-08-07T00:00:00.000Z'),
  ) => ({ id, type, scopeType, scopeId, projectId, payload: { n: 1 }, createdAt });

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
            projectId: args.data.projectId,
            payload: args.data.payload,
            createdAt: new Date(),
          }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
      task: { findUnique: jest.fn() },
      chatChannel: { findUnique: jest.fn() },
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

  describe('emit 解析 projectId（scope=all 可见项目过滤依据）', () => {
    it('task scope → 查 tasks.projectId 写入 projectId', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_1' });

      const ev = await service.emit(
        'team.changed',
        { taskId: 't_1' },
        { type: 'task', id: 't_1' },
      );

      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 't_1' },
        select: { projectId: true },
      });
      expect(ev.projectId).toBe('p_1');
      expect(prisma.realtimeEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ projectId: 'p_1' }),
      });
    });

    it('channel scope → channel.taskId → tasks.projectId 两级查询写入 projectId', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({ taskId: 't_1' });
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_1' });

      const ev = await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'channel', id: 'c_1' },
      );

      expect(prisma.chatChannel.findUnique).toHaveBeenCalledWith({
        where: { id: 'c_1' },
        select: { taskId: true },
      });
      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 't_1' },
        select: { projectId: true },
      });
      expect(ev.projectId).toBe('p_1');
    });

    it('global scope → 从 payload.taskId 反查 tasks.projectId 写入 projectId', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_1' });

      const ev = await service.emit('task.status.changed', {
        taskId: 't_1',
      });

      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 't_1' },
        select: { projectId: true },
      });
      expect(ev.projectId).toBe('p_1');
    });

    it('global scope payload 无 taskId → projectId 为 null（不查库）', async () => {
      const ev = await service.emit('team.changed', { projectId: 'p_1' });

      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      expect(ev.projectId).toBeNull();
    });

    it('解析目标不存在 → projectId 为 null（事件照常落库转发）', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      prisma.chatChannel.findUnique.mockResolvedValue(null);

      const evTask = await service.emit('a', {}, { type: 'task', id: 't_x' });
      expect(evTask.projectId).toBeNull();
      const evChannel = await service.emit(
        'b',
        {},
        { type: 'channel', id: 'c_x' },
      );
      expect(evChannel.projectId).toBeNull();
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
      await service.broadcast('team.changed', { projectId: 'p_1' }); // global

      expect(received).toHaveLength(1);
      expect((received[0].payload as { messageId: string }).messageId).toBe(
        'm_1',
      );
      unsubscribe();
    });

    it('global 订阅仅收到全局事件（不匹配 task/channel 事件）', async () => {
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        { type: 'global' },
      );

      await service.broadcast('team.changed', { projectId: 'p_1' }); // global
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
      const unsubscribe = service.subscribe((e) => received.push(e), [
        { type: 'task', id: 't_1' },
        { type: 'channel', id: 'c_1' },
      ]);

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
      await service.broadcast('team.changed', { projectId: 'p_1' }); // global

      expect(received.map((e) => (e.payload as { messageId: string }).messageId))
        .toEqual(['m_1', 'm_2']);
      unsubscribe();
    });

    it('unsubscribe 后不再收到事件', async () => {
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe((e) => received.push(e));
      unsubscribe();
      await service.broadcast('chat.message.new', {});
      expect(received).toHaveLength(0);
    });

    it('带 visibleProjectIds 仅转发命中可见项目的事件', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_1' });
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        ['p_1'],
      );

      await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      ); // projectId p_1 → 命中
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_2' });
      await service.emit(
        'chat.message.new',
        { messageId: 'm_2' },
        { type: 'task', id: 't_2' },
      ); // projectId p_2 → 未命中

      expect(received.map((e) => (e.payload as { messageId: string }).messageId))
        .toEqual(['m_1']);
      unsubscribe();
    });

    it('projectId 为 null 的事件不进可见项目过滤流（防止兜底泄露）', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe(
        (e) => received.push(e),
        undefined,
        ['p_1'],
      );

      await service.broadcast('team.changed', { projectId: 'p_1' }); // global 无 taskId → projectId null

      expect(received).toHaveLength(0);
      unsubscribe();
    });

    it('visibleProjectIds 为 null 时不过滤（保持既有订阅行为）', async () => {
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe((e) => received.push(e), undefined, null);

      await service.broadcast('a', { n: 1 });
      expect(received).toHaveLength(1);
      unsubscribe();
    });

    it('visibleProjectIds 显式空数组时任何事件都不放行（无可见项目防泄露）', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_1' });
      const received: RealtimeEvent[] = [];
      const unsubscribe = service.subscribe((e) => received.push(e), undefined, []);

      await service.emit(
        'chat.message.new',
        { messageId: 'm_1' },
        { type: 'task', id: 't_1' },
      );
      await service.broadcast('team.changed', { projectId: 'p_1' });

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

    it('带 visibleProjectIds 时叠加 projectId in 过滤 DB 查询', async () => {
      const events = await service.getEventsSince('ev_0000000001', undefined, [
        'p_1',
        'p_2',
      ]);

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { projectId: { in: ['p_1', 'p_2'] }, id: { gt: 'ev_0000000001' } },
        orderBy: { id: 'asc' },
      });
      expect(events).toEqual([]);
    });

    it('visibleProjectIds 与 scope 同时指定时 AND 组合过滤', async () => {
      await service.getEventsSince(undefined, { type: 'task', id: 't_1' }, [
        'p_1',
      ]);

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ scopeType: 'task', scopeId: 't_1' }],
          projectId: { in: ['p_1'] },
        },
        orderBy: { id: 'asc' },
      });
    });

    it('visibleProjectIds 为 null 时不过滤（保持既有查询行为）', async () => {
      await service.getEventsSince('ev_0000000001', { type: 'global' }, null);

      expect(prisma.realtimeEvent.findMany).toHaveBeenCalledWith({
        where: { OR: [{ scopeType: 'global' }], id: { gt: 'ev_0000000001' } },
        orderBy: { id: 'asc' },
      });
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

    it('DB 行映射为事件帧：createdAt → ISO8601 timestamp', async () => {
      prisma.realtimeEvent.findMany.mockResolvedValue([
        row(
          'ev_0000000005',
          'task.status.changed',
          'task',
          't_9',
          'p_1',
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
        projectId: 'p_1',
      });
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
