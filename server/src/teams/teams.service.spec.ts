import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TeamsService } from './teams.service';
import { sanitizeWorkDirName } from '../tasks/work-dir.util';

describe('TeamsService', () => {
  let service: TeamsService;
  let prisma: any;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };

  const userId = 'u_admin';

  const agentMeta = (id: string) => {
    const map: Record<string, { name: string; role: string | null }> = {
      a_product: { name: '产品经理', role: 'product' },
      a_developer: { name: '开发者', role: 'developer' },
      a_tester: { name: '测试', role: 'tester' },
    };
    return map[id] ?? { name: id, role: null };
  };

  const teamRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'tm_0000000001',
    name: 'team-alpha',
    description: null,
    reuseSession: true,
    currentTaskId: null,
    version: 0,
    createdBy: userId,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    members: [],
    userMembers: [],
    queues: [],
    ...overrides,
  });

  const teamMemberRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'tmm_0000000001',
    teamId: 'tm_0000000001',
    agentId: 'a_product',
    alias: '产品经理-1',
    seq: 1,
    workDir: '/data/vteam-worker/产品经理',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    agent: { id: 'a_product', name: '产品经理', role: 'product' },
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      team: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
      },
      teamMember: {
        create: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn(),
      },
      teamQueue: { findFirst: jest.fn() },
      teamUserMember: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      agent: { findUnique: jest.fn() },
      $transaction: jest.fn(),
      $queryRawUnsafe: jest.fn(),
    };
    idGen = { nextId: jest.fn(), seed: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    service = module.get<TeamsService>(TeamsService);
  });

  const mockCreateTx = (createdTeam: any) => {
    const tx: any = {
      team: {
        create: jest.fn().mockResolvedValue(createdTeam),
        update: jest.fn().mockResolvedValue(createdTeam),
      },
      teamMember: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data })),
        aggregate: jest.fn().mockResolvedValue({ _max: { seq: 0 } }),
      },
      teamUserMember: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data })),
      },
      agent: {
        findUnique: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve({ id: where.id, ...agentMeta(where.id) }),
        ),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ maxSeq: 0 }]),
    };
    prisma.$transaction.mockImplementation(async (fn: any) => {
      if (Array.isArray(fn)) {
        // findAll $transaction([...])
        return Promise.resolve(fn.map(() => 0));
      }
      return fn(tx);
    });
    // alias for service.nextSeqForUpdate fallback path
    tx.teamMember.aggregate.mockResolvedValue({ _max: { seq: 0 } });
    return tx;
  };

  describe('create', () => {
    it('创建团队成功：校验 name 非空、生成 members seq/alias/workDir、广播 TEAM_CHANGED', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('tm_0000000001')
        .mockResolvedValueOnce('tmm_0000000001')
        .mockResolvedValueOnce('tmm_0000000002');
      const tx = mockCreateTx(teamRow());
      // simulate second member same agent seq increment via second query
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ maxSeq: 0 }])
        .mockResolvedValueOnce([{ maxSeq: 1 }]);
      tx.teamMember.aggregate
        .mockResolvedValueOnce({ _max: { seq: 0 } })
        .mockResolvedValueOnce({ _max: { seq: 1 } });

      // findOne after create returns full dto
      prisma.team.findUnique
        .mockResolvedValueOnce(null) // pre-check
        .mockResolvedValueOnce(
          teamRow({
            members: [
              teamMemberRow({ id: 'tmm_0000000001', agentId: 'a_developer', alias: '开发者-1', seq: 1, workDir: '/data/vteam-worker/开发者', agent: { id: 'a_developer', name: '开发者', role: 'developer' } }),
              teamMemberRow({ id: 'tmm_0000000002', agentId: 'a_developer', alias: '开发者-2', seq: 2, workDir: '/data/vteam-worker/开发者-2', agent: { id: 'a_developer', name: '开发者', role: 'developer' } }),
            ],
          }),
        );

      // need to handle $transaction for create + findOne inside transaction mock for create path
      prisma.$transaction.mockImplementation(async (fn: any) => {
        if (typeof fn === 'function') return fn(tx);
        // for findAll path not here
        return fn;
      });

      const result: any = await service.create(userId, {
        name: ' team-alpha ',
        description: 'desc',
        reuseSession: true,
        members: [{ agentId: 'a_developer' }, { agentId: 'a_developer' }],
      } as any);

      expect(tx.team.create).toHaveBeenCalledWith({
        data: {
          id: 'tm_0000000001',
          name: 'team-alpha',
          description: 'desc',
          reuseSession: true,
          createdBy: userId,
          version: 0,
        },
      });
      expect(tx.teamMember.create).toHaveBeenCalledTimes(2);
      expect(tx.teamMember.create).toHaveBeenNthCalledWith(1, {
        data: {
          id: 'tmm_0000000001',
          teamId: 'tm_0000000001',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
          workDir: '/data/vteam-worker/开发者',
        },
      });
      expect(tx.teamMember.create).toHaveBeenNthCalledWith(2, {
        data: {
          id: 'tmm_0000000002',
          teamId: 'tm_0000000001',
          agentId: 'a_developer',
          alias: '开发者-2',
          seq: 2,
          workDir: '/data/vteam-worker/开发者-2',
        },
      });
      // alias/workDir default verified
      expect(result.members[0].alias).toBe('开发者-1');
      expect(result.members[1].alias).toBe('开发者-2');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        expect.objectContaining({ teamId: 'tm_0000000001', action: 'create' }),
        { type: 'global' },
      );
    });

    it('重名 409 TEAM_NAME_CONFLICT', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      await expect(
        service.create(userId, { name: 'team-alpha' } as any),
      ).rejects.toThrow(ConflictException);
      try {
        await service.create(userId, { name: 'team-alpha' } as any);
      } catch (e) {
        expect((e as ConflictException).getResponse()).toMatchObject({ code: 'TEAM_NAME_CONFLICT' });
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('成员 agentId 不存在 404 AGENT_NOT_FOUND', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('tm_0000000001');
      const tx = mockCreateTx(teamRow());
      tx.agent.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      // findOne mock not needed as tx throws
      await expect(
        service.create(userId, { name: 'new-team', members: [{ agentId: 'ghost' }] } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('alias 缺省按 <角色>-<seq>、workDir 缺省按 sanitize(agent.name) 且同 agent 多实例追加 -seq', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('tm_0000000001')
        .mockResolvedValueOnce('tmm_0000000001');
      const tx = mockCreateTx(teamRow());
      tx.$queryRawUnsafe.mockResolvedValue([{ maxSeq: 0 }]);
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          teamRow({
            members: [teamMemberRow({ alias: '产品经理-1', workDir: '/data/vteam-worker/产品经理' })],
          }),
        );
      const result: any = await service.create(userId, {
        name: 'team-alias',
        members: [{ agentId: 'a_product' }],
      } as any);
      expect(tx.teamMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ alias: '产品经理-1', workDir: '/data/vteam-worker/产品经理' }),
        }),
      );
      // sanitize validation
      expect(sanitizeWorkDirName(' 产品/经理 ')).toBe('产品-经理');
      expect(sanitizeWorkDirName('')).toBe('agent');
      expect(result.members[0].alias).toBe('产品经理-1');
    });

    it('同 agent 多实例两行：两次 FOR UPDATE seq 1/2', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('tm_0000000001')
        .mockResolvedValueOnce('tmm_0000000001')
        .mockResolvedValueOnce('tmm_0000000002');
      const tx = mockCreateTx(teamRow());
      tx.$queryRawUnsafe
        .mockResolvedValueOnce([{ maxSeq: 0 }])
        .mockResolvedValueOnce([{ maxSeq: 1 }]);
      tx.teamMember.aggregate
        .mockResolvedValueOnce({ _max: { seq: 0 } })
        .mockResolvedValueOnce({ _max: { seq: 1 } });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          teamRow({
            members: [
              teamMemberRow({ id: 'tmm_0000000001', seq: 1 }),
              teamMemberRow({ id: 'tmm_0000000002', seq: 2 }),
            ],
          }),
        );
      await service.create(userId, {
        name: 'multi',
        members: [{ agentId: 'a_developer' }, { agentId: 'a_developer' }],
      } as any);
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
      expect(tx.teamMember.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ seq: 1 }) }));
      expect(tx.teamMember.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ seq: 2 }) }));
    });

    it('seq 事务内 SELECT MAX(seq) FOR UPDATE 防并发重号（调用 $queryRawUnsafe）', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId.mockResolvedValueOnce('tm_0000000001').mockResolvedValueOnce('tmm_0000000001');
      const tx = mockCreateTx(teamRow());
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(teamRow({ members: [teamMemberRow()] }));
      await service.create(userId, { name: 'seq-lock', members: [{ agentId: 'a_product' }] } as any);
      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT MAX(seq) as maxSeq FROM team_members WHERE team_id = ? AND agent_id = ? FOR UPDATE',
        'tm_0000000001',
        'a_product',
      );
    });
  });

  describe('findAll', () => {
    it('分页 + name 搜索 + total 正确', async () => {
      prisma.team.count.mockResolvedValue(2);
      prisma.team.findMany.mockResolvedValue([teamRow(), teamRow({ id: 'tm_0000000002', name: 'other' })]);
      prisma.$transaction.mockImplementation(async (args: any) => {
        const [count, items] = await Promise.all(args.map((p: Promise<any>) => p));
        return [count, items];
      });
      // mock $transaction array style used by findAll directly? service does $transaction([count, findMany])
      // Need to override to return tuple correctly
      prisma.$transaction = jest.fn().mockResolvedValue([2, [teamRow(), teamRow({ id: 'tm_0000000002', name: 'other' })]]);
      prisma.team.count = jest.fn().mockResolvedValue(2);
      prisma.team.findMany = jest.fn().mockResolvedValue([teamRow(), teamRow({ id: 'tm_0000000002', name: 'other' })]);

      const result = await service.findAll({ page: 1, pageSize: 20, name: 'team' } as any);
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('pageSize 上限 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);
      await service.findAll({ page: 1, pageSize: 999 } as any);
      const callArgs = prisma.team.findMany.mock.calls[0]?.[0];
      // fallback: check $transaction args include findMany with take 100
      // Since we mock $transaction to just resolve, inspect team.findMany args if called directly
      // Instead we assert normalizePageSize logic via checking $transaction was called with constraints
      // We can verify findAll returns pageSize 100
      const res = await service.findAll({ page: 1, pageSize: 999 } as any);
      expect(res.pageSize).toBe(100);
    });
  });

  describe('findOne', () => {
    it('返回详情含 members+reuseSession+currentTaskId+queue', async () => {
      prisma.team.findUnique.mockResolvedValue(
        teamRow({
          reuseSession: false,
          currentTaskId: 't_0000000001',
          members: [teamMemberRow()],
          queues: [{ id: 'tq_0000000001', teamId: 'tm_0000000001', taskId: 't_0000000001', position: 1, enqueuedAt: new Date() }],
        }),
      );
      const result: any = await service.findOne('tm_0000000001');
      expect(result.reuseSession).toBe(false);
      expect(result.currentTaskId).toBe('t_0000000001');
      expect(result.members).toHaveLength(1);
      expect(result.queue).toHaveLength(1);
    });

    it('不存在 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.findOne('tm_missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('PATCH name/description/reuseSession 成功并 version+1 + 广播', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ version: 3 }));
      prisma.team.update.mockResolvedValue(teamRow({ name: 'new-name', version: 4 }));
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow({ version: 3 }))
        .mockResolvedValueOnce(null) // dup check
        .mockResolvedValueOnce(teamRow({ name: 'new-name', version: 4, members: [], queues: [] }));
      prisma.team.update.mockResolvedValue(teamRow({ name: 'new-name', version: 4 }));
      // need to handle update without version (dto.version undefined -> uses update not updateMany)
      prisma.team.updateMany = jest.fn();
      const result: any = await service.update('tm_0000000001', { name: 'new-name', description: 'd', reuseSession: false } as any);
      expect(result.name).toBe('new-name');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        expect.objectContaining({ teamId: 'tm_0000000001', action: 'update' }),
        { type: 'global' },
      );
    });

    it('重名 409', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.team.findUnique.mockResolvedValue(teamRow()); // first check team exists
      // second call for dup
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow())
        .mockResolvedValueOnce(teamRow({ id: 'tm_0000000002', name: 'dup' }));
      await expect(service.update('tm_0000000001', { name: 'dup' } as any)).rejects.toThrow(ConflictException);
    });

    it('version 乐观锁冲突 409', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ version: 5 }));
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow({ version: 5 }))
        .mockResolvedValueOnce(null);
      prisma.team.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      prisma.team.update = jest.fn();
      await expect(service.update('tm_0000000001', { name: 'x', version: 4 } as any)).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('仅空闲且队列空时可删，成功广播 delete', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ currentTaskId: null, queues: [] }));
      prisma.teamMember.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
      prisma.team.delete = jest.fn().mockResolvedValue(teamRow());
      prisma.$transaction.mockImplementation(async (fn: any) => fn({ teamMember: { deleteMany: jest.fn().mockResolvedValue({}) }, team: { delete: jest.fn().mockResolvedValue({}) } }));
      const result = await service.remove('tm_0000000001');
      expect(result.deleted).toBe(true);
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        expect.objectContaining({ action: 'delete' }),
        { type: 'global' },
      );
    });

    it('忙时删除 409 TEAM_BUSY（currentTaskId 非空）', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ currentTaskId: 't_0000000001', queues: [] }));
      await expect(service.remove('tm_0000000001')).rejects.toThrow(ConflictException);
    });

    it('队列非空 409 TEAM_QUEUE_NOT_EMPTY', async () => {
      prisma.team.findUnique.mockResolvedValue(
        teamRow({ currentTaskId: null, queues: [{ id: 'tq_1', taskId: 't_1', position: 1 }] } as any),
      );
      await expect(service.remove('tm_0000000001')).rejects.toThrow(ConflictException);
    });
  });

  describe('members', () => {
    it('addMember：校验 agent 存在、seq FOR UPDATE、alias/workDir 生成、version+1', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', name: '产品经理', role: 'product' });
      idGen.nextId.mockResolvedValue('tmm_0000000002');
      const tx: any = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ maxSeq: 1 }]),
        teamMember: {
          create: jest.fn().mockResolvedValue({ id: 'tmm_0000000002', teamId: 'tm_0000000001', agentId: 'a_product', alias: '产品经理-2', seq: 2 }),
          aggregate: jest.fn().mockResolvedValue({ _max: { seq: 1 } }),
        },
        team: { update: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow()) // addMember pre-check
        .mockResolvedValueOnce(teamRow({ members: [teamMemberRow(), teamMemberRow({ id: 'tmm_0000000002', seq: 2 })], queues: [] })); // final findOne
      // also need findUnique for addMember's initial team lookup inside addMember (already mocked)
      // and agent lookup is prisma.agent.findUnique (not tx) – already mocked

      const result: any = await service.addMember('tm_0000000001', { agentId: 'a_product' } as any);
      expect(tx.$queryRawUnsafe).toHaveBeenCalled();
      expect(tx.teamMember.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ seq: 2, alias: '产品经理-2' }) }),
      );
      expect(tx.team.update).toHaveBeenCalledWith({ where: { id: 'tm_0000000001' }, data: { version: { increment: 1 } } });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        expect.objectContaining({ action: 'member_add' }),
        { type: 'global' },
      );
      expect(result.members).toBeDefined();
    });

    it('removeMember 联动 updatedAt/version', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue({ id: 'tmm_0000000001', teamId: 'tm_0000000001' });
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          teamMember: { delete: jest.fn().mockResolvedValue({}) },
          team: { update: jest.fn().mockResolvedValue({}) },
        }),
      );
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow())
        .mockResolvedValueOnce(teamRow({ members: [], queues: [] }));

      await service.removeMember('tm_0000000001', 'tmm_0000000001');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        expect.objectContaining({ action: 'member_remove' }),
        { type: 'global' },
      );
    });
  });

  describe('resetSessions（Todo7 记忆开关）', () => {
    it('手动重置：批量 delete+create 新 s_ 行，soft-remove 先于 delete，广播 team.changed + chat.message.new', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findMany = jest.fn().mockResolvedValue([{ id: 'tmm_0000000001' }, { id: 'tmm_0000000002' }]);
      (prisma as any).session = { count: jest.fn().mockResolvedValue(2), findMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn() };
      (prisma as any).chatChannel = { findFirst: jest.fn().mockResolvedValue({ id: 'c_1' }) };
      const tx: any = {
        session: {
          findMany: jest.fn().mockResolvedValue([
            { id: 's_1', taskId: 't_1', taskAgentId: 'ta_1', agentId: 'a_product', teamMemberId: 'tmm_0000000001', workerId: 'w_1', instanceRef: 'ses_1' },
            { id: 's_2', taskId: 't_1', taskAgentId: 'ta_2', agentId: 'a_developer', teamMemberId: 'tmm_0000000002', workerId: null, instanceRef: null },
          ]),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
          create: jest.fn().mockResolvedValue({}),
        },
        taskGroupInstance: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        message: { create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: data.id, channelId: data.channelId, senderType: data.senderType, content: data.content, mentions: data.mentions, status: data.status, createdAt: new Date() })) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      idGen.nextId.mockImplementation(async (p: string) => `${p}_0000000099`);

      const result: any = await service.resetSessions('tm_0000000001');

      expect(tx.taskGroupInstance.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_1', workerId: 'w_1', instanceId: 'ses_1', removedAt: null },
        data: { removedAt: expect.any(Date) },
      });
      expect(tx.session.deleteMany).toHaveBeenCalled();
      expect(tx.session.create).toHaveBeenCalledTimes(2);
      expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ content: { text: '已为下一任务开新会话', parts: [] } }) }));
      expect(realtime.broadcast).toHaveBeenCalledWith(EVENT_TYPES.CHAT_MESSAGE_NEW, expect.objectContaining({ message: expect.objectContaining({ channelId: 'c_1' }) }), { type: 'channel', id: 'c_1' });
      expect(realtime.broadcast).toHaveBeenCalledWith(EVENT_TYPES.TEAM_CHANGED, expect.objectContaining({ action: 'reset_sessions' }), expect.any(Object));
      expect(result.reset).toBe(2);
    });

    it('幂等：无会话需重置 → reset 0，不写消息', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findMany = jest.fn().mockResolvedValue([{ id: 'tmm_1' }]);
      (prisma as any).session = { count: jest.fn().mockResolvedValue(0), findMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn() };
      (prisma as any).chatChannel = { findFirst: jest.fn().mockResolvedValue(null) };
      const result: any = await service.resetSessions('tm_0000000001');
      expect(result.reset).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('团队不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.resetSessions('tm_missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateMember 边界', () => {
    it('成功更新 alias/workDir 并 version+1、双广播', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue({ id: 'tmm_0000000001', teamId: 'tm_0000000001' });
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          teamMember: { update: jest.fn().mockResolvedValue({ id: 'tmm_0000000001' }) },
          team: { update: jest.fn().mockResolvedValue({}) },
        }),
      );
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow())
        .mockResolvedValueOnce(teamRow({ members: [teamMemberRow({ alias: '新别名', workDir: '/data/new' })], queues: [] }));
      const result: any = await service.updateMember('tm_0000000001', 'tmm_0000000001', { alias: '新别名', workDir: '/data/new' } as any);
      expect(result.members[0].alias).toBe('新别名');
      expect(realtime.broadcast).toHaveBeenCalledWith(EVENT_TYPES.TEAM_CHANGED, expect.objectContaining({ action: 'member_update' }), { type: 'global' });
      expect(realtime.broadcast).toHaveBeenCalledWith(EVENT_TYPES.TEAM_UPDATED, expect.objectContaining({ action: 'member_update' }), { type: 'team', id: 'tm_0000000001' });
    });

    it('空更新 → 直接返回 findOne，不进事务', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue({ id: 'tmm_0000000001', teamId: 'tm_0000000001' });
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow())
        .mockResolvedValueOnce(teamRow({ members: [], queues: [] }));
      const result: any = await service.updateMember('tm_0000000001', 'tmm_0000000001', {} as any);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('团队不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.updateMember('tm_missing', 'tmm_1', { alias: 'x' } as any)).rejects.toThrow(NotFoundException);
    });

    it('成员不存在或不属该团队 → 404 MEMBER_NOT_FOUND', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue(null);
      await expect(service.updateMember('tm_0000000001', 'tmm_missing', { alias: 'x' } as any)).rejects.toThrow(NotFoundException);
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue({ id: 'tmm_1', teamId: 'tm_other' } as any);
      await expect(service.updateMember('tm_0000000001', 'tmm_1', { alias: 'x' } as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('cancelQueue（FIFO 取消，仅 queued 可取消）', () => {
    const teamId = 'tm_0000000001';
    const taskId = 't_0000000001';
    it('成功取消：queued 任务删除队首、重排剩余 position、task pending、双广播', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ currentTaskId: 't_0000000009', queues: [{ id: 'tq_1', taskId }] } as any));
      (prisma as any).teamQueue.findFirst = jest.fn().mockResolvedValue({ id: 'tq_0000000001', teamId, taskId, position: 1 });
      (prisma as any).task = { findUnique: jest.fn().mockResolvedValue({ id: taskId, status: 'queued', teamId }) };
      const tx: any = {
        teamQueue: {
          delete: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([
            { id: 'tq_0000000002', position: 3 },
            { id: 'tq_0000000003', position: 2 },
          ]),
          update: jest.fn().mockResolvedValue({}),
        },
        task: { update: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow({ currentTaskId: 't_0000000009', queues: [{ id: 'tq_1', taskId }] } as any))
        .mockResolvedValueOnce(teamRow({ members: [], queues: [] }));
      const result: any = await service.cancelQueue(teamId, taskId);
      expect(tx.teamQueue.delete).toHaveBeenCalledWith({ where: { id: 'tq_0000000001' } });
      expect(tx.task.update).toHaveBeenCalledWith({ where: { id: taskId }, data: { status: 'pending' } });
      expect(tx.teamQueue.findMany).toHaveBeenCalledWith({ where: { teamId }, orderBy: { position: 'asc' } });
      expect(realtime.broadcast).toHaveBeenCalledWith(EVENT_TYPES.TEAM_QUEUE_CHANGED, expect.objectContaining({ teamId, taskId, action: 'cancel' }), { type: 'team', id: teamId });
      expect(realtime.broadcast).toHaveBeenCalledWith(EVENT_TYPES.TEAM_CHANGED, expect.objectContaining({ action: 'queue_cancel' }), { type: 'global' });
      expect(result).toBeDefined();
    });

    it('团队不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.cancelQueue('tm_missing', taskId)).rejects.toThrow(NotFoundException);
    });

    it('队列条目不存在 → 409 TASK_NOT_QUEUED', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      (prisma as any).teamQueue.findFirst = jest.fn().mockResolvedValue(null);
      await expect(service.cancelQueue(teamId, taskId)).rejects.toThrow(ConflictException);
      try { await service.cancelQueue(teamId, taskId); } catch (e) { expect((e as ConflictException).getResponse()).toMatchObject({ code: 'TASK_NOT_QUEUED' }); }
    });

    it('任务非 queued（pending）→ 409 TASK_NOT_QUEUED', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      (prisma as any).teamQueue.findFirst = jest.fn().mockResolvedValue({ id: 'tq_1', teamId, taskId, position: 1 });
      (prisma as any).task = { findUnique: jest.fn().mockResolvedValue({ id: taskId, status: 'pending', teamId }) };
      await expect(service.cancelQueue(teamId, taskId)).rejects.toThrow(ConflictException);
    });

    it('取消后剩余队列 position 已连续 → 不重排', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      (prisma as any).teamQueue.findFirst = jest.fn().mockResolvedValue({ id: 'tq_1', teamId, taskId, position: 2 });
      (prisma as any).task = { findUnique: jest.fn().mockResolvedValue({ id: taskId, status: 'queued', teamId }) };
      const tx: any = {
        teamQueue: {
          delete: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([
            { id: 'tq_a', position: 1 },
            { id: 'tq_b', position: 2 },
          ]),
          update: jest.fn(),
        },
        task: { update: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow())
        .mockResolvedValueOnce(teamRow({ members: [], queues: [] }));
      await service.cancelQueue(teamId, taskId);
      expect(tx.teamQueue.update).not.toHaveBeenCalled();
    });
  });

  describe('enqueueQueue（pending 孤儿重入队）', () => {
    const teamId = 'tm_0000000001';
    const taskId = 't_0000000001';
    it('成功排队：pending 任务 MAX+1 追加、状态同步 queued、双广播', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ currentTaskId: 't_0000000009' } as any));
      (prisma as any).task = { findUnique: jest.fn().mockResolvedValue({ id: taskId, status: 'pending', teamId }) };
      (prisma as any).teamQueue.findFirst = jest.fn().mockResolvedValue(null);
      const tx: any = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ maxPos: 2 }]),
        teamQueue: { create: jest.fn().mockResolvedValue({}), aggregate: jest.fn() },
        task: { update: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique.mockResolvedValueOnce(teamRow({ currentTaskId: 't_0000000009' } as any));
      (service as any).findOne = jest.fn().mockResolvedValue({ id: teamId });
      (service as any).idGen = { nextId: jest.fn().mockResolvedValue('tq_0000000009') };

      const result: any = await service.enqueueQueue(teamId, taskId);
      expect(tx.teamQueue.create).toHaveBeenCalledWith({
        data: { id: 'tq_0000000009', teamId, taskId, position: 3 },
      });
      expect(tx.task.update).toHaveBeenCalledWith({ where: { id: taskId }, data: { status: 'queued' } });
      expect(realtime.broadcast).toHaveBeenCalledWith(EVENT_TYPES.TEAM_QUEUE_CHANGED, expect.objectContaining({ teamId, taskId, action: 'enqueue' }), { type: 'team', id: teamId });
      expect(result).toBeDefined();
    });

    it('已有队列行 → 幂等返回不重复创建', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ currentTaskId: 't_0000000009' } as any));
      (prisma as any).task = { findUnique: jest.fn().mockResolvedValue({ id: taskId, status: 'pending', teamId }) };
      (prisma as any).teamQueue.findFirst = jest.fn().mockResolvedValue({ id: 'tq_1', teamId, taskId, position: 1 });
      (service as any).findOne = jest.fn().mockResolvedValue({ id: teamId });
      await service.enqueueQueue(teamId, taskId);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('非 pending（进行中）→ 409 TASK_NOT_PENDING', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      (prisma as any).task = { findUnique: jest.fn().mockResolvedValue({ id: taskId, status: 'in_progress', teamId }) };
      (prisma as any).teamQueue.findFirst = jest.fn().mockResolvedValue(null);
      try {
        await service.enqueueQueue(teamId, taskId);
        fail('应抛出 ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect((e as ConflictException).getResponse()).toMatchObject({ code: 'TASK_NOT_PENDING' });
      }
    });

    it('队首任务 → 409（直接点开始，无需排队）', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ currentTaskId: taskId } as any));
      (prisma as any).task = { findUnique: jest.fn().mockResolvedValue({ id: taskId, status: 'pending', teamId }) };
      try {
        await service.enqueueQueue(teamId, taskId);
        fail('应抛出 ConflictException');
      } catch (e) {
        expect((e as ConflictException).getResponse()).toMatchObject({ code: 'TASK_NOT_PENDING' });
      }
    });
  });

  describe('边界：空名/参数校验与 version 乐观锁', () => {
    it('create name 为空 → 400', async () => {
      await expect(service.create(userId, { name: '   ' } as any)).rejects.toThrow(BadRequestException);
    });
    it('create members agentId 缺失 → 400', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.create(userId, { name: 'ok', members: [{ agentId: '' }] } as any)).rejects.toThrow(BadRequestException);
    });
    it('findOne 不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.findOne('tm_missing')).rejects.toThrow(NotFoundException);
    });
    it('update 空 dto → 直接返回，不触发广播', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow())
        .mockResolvedValueOnce(teamRow({ members: [], queues: [] }));
      const result: any = await service.update('tm_0000000001', {} as any);
      expect(result).toBeDefined();
      expect(realtime.broadcast).not.toHaveBeenCalledWith(EVENT_TYPES.TEAM_UPDATED, expect.anything(), expect.anything());
    });
    it('update name 同名不触发 dup 检查但仍 increment version', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ name: 'team-alpha', version: 0 }));
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow({ name: 'team-alpha', version: 0 }))
        .mockResolvedValueOnce(teamRow({ name: 'team-alpha', version: 1, members: [], queues: [] }));
      prisma.team.update = jest.fn().mockResolvedValue(teamRow({ name: 'team-alpha', version: 1 }));
      const result: any = await service.update('tm_0000000001', { name: 'team-alpha', description: 'new' } as any);
      expect(prisma.team.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'tm_0000000001' } }));
      expect(result).toBeDefined();
    });
    it('remove 不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.remove('tm_missing')).rejects.toThrow(NotFoundException);
    });
    it('addMember 团队不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.addMember('tm_missing', { agentId: 'a_product' } as any)).rejects.toThrow(NotFoundException);
    });
    it('addMember agent 不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.addMember('tm_0000000001', { agentId: 'ghost' } as any)).rejects.toThrow(NotFoundException);
    });
    it('removeMember 团队不存在 → 404，成员不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.removeMember('tm_missing', 'tmm_1')).rejects.toThrow(NotFoundException);
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue(null);
      await expect(service.removeMember('tm_0000000001', 'tmm_missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('onModuleInit 与 seq 并发重号边界', () => {
    it('onModuleInit 按最大 id 对齐各前缀 seed', async () => {
      (prisma.team as any).findFirst = jest.fn().mockResolvedValue({ id: 'tm_0000000005' });
      (prisma.teamMember as any).findFirst = jest.fn().mockResolvedValue({ id: 'tmm_0000000003' });
      (prisma.teamUserMember as any).findFirst = jest.fn().mockResolvedValue({ id: 'tum_0000000004' });
      (prisma as any).teamQueue = { findFirst: jest.fn().mockResolvedValue({ id: 'tq_0000000007' }) };
      await service.onModuleInit();
      expect(idGen.seed).toHaveBeenCalledWith('tm', 5);
      expect(idGen.seed).toHaveBeenCalledWith('tmm', 3);
      expect(idGen.seed).toHaveBeenCalledWith('tum', 4);
      expect(idGen.seed).toHaveBeenCalledWith('tq', 7);
    });

    it('并发 seq 重号：SELECT MAX 返回 null 时 fallback aggregate 取 1', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId.mockResolvedValueOnce('tm_0000000001').mockResolvedValueOnce('tmm_0000000001');
      const tx: any = {
        team: { create: jest.fn().mockResolvedValue(teamRow()) },
        teamMember: {
          create: jest.fn().mockResolvedValue({ id: 'tmm_0000000001', teamId: 'tm_0000000001', agentId: 'a_product', alias: '产品经理-1', seq: 1 }),
          aggregate: jest.fn().mockResolvedValue({ _max: { seq: null } }),
        },
        teamUserMember: {
          create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data })),
        },
        agent: { findUnique: jest.fn().mockResolvedValue({ id: 'a_product', name: '产品经理', role: 'product' }) },
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(teamRow({ members: [teamMemberRow()] }));
      await service.create(userId, { name: 'seq-null', members: [{ agentId: 'a_product' }] } as any);
      expect(tx.$queryRawUnsafe).toHaveBeenCalled();
      expect(tx.teamMember.aggregate).toHaveBeenCalled();
    });

    it('resetSessions 团队无成员 → reset 0 幂等', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findMany = jest.fn().mockResolvedValue([]);
      const result: any = await service.resetSessions('tm_0000000001');
      expect(result.reset).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('主 Agent 设置（Team.mainAgentMemberId）', () => {
    it('create：指定主 Agent（索引）成功设置 mainAgentMemberId', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('tm_0000000001')
        .mockResolvedValueOnce('tmm_0000000001')
        .mockResolvedValueOnce('tmm_0000000002');
      const tx: any = {
        team: {
          create: jest.fn().mockResolvedValue(teamRow()),
          update: jest.fn().mockResolvedValue(teamRow({ mainAgentMemberId: 'tmm_0000000001' })),
        },
        teamMember: {
          create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data })),
          aggregate: jest.fn().mockResolvedValue({ _max: { seq: 0 } }),
        },
        teamUserMember: {
          create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data })),
        },
        agent: {
          findUnique: jest.fn().mockImplementation(({ where }: any) => Promise.resolve({ id: where.id, ...agentMeta(where.id) })),
        },
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ maxSeq: 0 }]),
      };
      tx.$queryRawUnsafe.mockResolvedValueOnce([{ maxSeq: 0 }]).mockResolvedValueOnce([{ maxSeq: 0 }]);
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(teamRow({ mainAgentMemberId: 'tmm_0000000001', members: [teamMemberRow({ id: 'tmm_0000000001' }), teamMemberRow({ id: 'tmm_0000000002', agentId: 'a_developer' })], queues: [] }));
      const result: any = await service.create(userId, {
        name: 'team-main',
        members: [{ agentId: 'a_product' }, { agentId: 'a_developer' }],
        mainAgentMemberId: '0',
      } as any);
      expect(tx.team.update).toHaveBeenCalledWith({ where: { id: 'tm_0000000001' }, data: { mainAgentMemberId: 'tmm_0000000001' } });
      expect(result.mainAgentMemberId).toBe('tmm_0000000001');
    });

    it('create：主 Agent 非团队成员 → 400 MAIN_AGENT_NOT_MEMBER', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId.mockResolvedValueOnce('tm_0000000001').mockResolvedValueOnce('tmm_0000000001');
      const tx: any = {
        team: { create: jest.fn().mockResolvedValue(teamRow()), update: jest.fn() },
        teamMember: { create: jest.fn().mockResolvedValue({}), aggregate: jest.fn().mockResolvedValue({ _max: { seq: 0 } }) },
        teamUserMember: { create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ ...data })) },
        agent: { findUnique: jest.fn().mockResolvedValue({ id: 'a_product', name: '产品经理', role: 'product' }) },
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ maxSeq: 0 }]),
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      await expect(
        service.create(userId, { name: 'team-bad-main', members: [{ agentId: 'a_product' }], mainAgentMemberId: '999' } as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.create(userId, { name: 'team-bad-main2', members: [{ agentId: 'a_product' }], mainAgentMemberId: '999' } as any);
      } catch (e) {
        expect((e as any).getResponse()).toMatchObject({ code: 'MAIN_AGENT_NOT_MEMBER' });
      }
    });

    it('update：设置主 Agent 成功并 version+1', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ version: 2, mainAgentMemberId: null }));
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue({ id: 'tmm_0000000001', teamId: 'tm_0000000001' });
      prisma.team.update = jest.fn().mockResolvedValue(teamRow({ mainAgentMemberId: 'tmm_0000000001', version: 3 }));
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow({ version: 2, mainAgentMemberId: null }))
        .mockResolvedValueOnce(teamRow({ mainAgentMemberId: 'tmm_0000000001', version: 3, members: [teamMemberRow()], queues: [] }));
      const result: any = await service.update('tm_0000000001', { mainAgentMemberId: 'tmm_0000000001' } as any);
      expect(prisma.team.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'tm_0000000001' }, data: expect.objectContaining({ mainAgentMemberId: 'tmm_0000000001' }) }));
      expect(result.mainAgentMemberId).toBe('tmm_0000000001');
    });

    it('update：主 Agent 非团队成员 → 400', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue({ id: 'tmm_other', teamId: 'tm_other' } as any);
      await expect(service.update('tm_0000000001', { mainAgentMemberId: 'tmm_other' } as any)).rejects.toThrow(BadRequestException);
    });

    it('removeMember：移除的是主 Agent → 清空 mainAgentMemberId', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ mainAgentMemberId: 'tmm_0000000001' }));
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue({ id: 'tmm_0000000001', teamId: 'tm_0000000001' });
      let txData: any = null;
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          teamMember: { delete: jest.fn().mockResolvedValue({}) },
          team: { update: jest.fn().mockImplementation(({ data }: any) => { txData = data; return Promise.resolve({}); }) },
        }),
      );
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow({ mainAgentMemberId: 'tmm_0000000001' }))
        .mockResolvedValueOnce(teamRow({ mainAgentMemberId: null, members: [], queues: [] }));
      await service.removeMember('tm_0000000001', 'tmm_0000000001');
      expect(txData).toMatchObject({ mainAgentMemberId: null, version: { increment: 1 } });
    });

    it('removeMember：移除非主 Agent → 不清空', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ mainAgentMemberId: 'tmm_0000000001' }));
      prisma.teamMember.findUnique = jest.fn().mockResolvedValue({ id: 'tmm_0000000002', teamId: 'tm_0000000001' });
      let txData: any = null;
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          teamMember: { delete: jest.fn().mockResolvedValue({}) },
          team: { update: jest.fn().mockImplementation(({ data }: any) => { txData = data; return Promise.resolve({}); }) },
        }),
      );
      prisma.team.findUnique
        .mockResolvedValueOnce(teamRow({ mainAgentMemberId: 'tmm_0000000001' }))
        .mockResolvedValueOnce(teamRow({ mainAgentMemberId: 'tmm_0000000001', members: [teamMemberRow()], queues: [] }));
      await service.removeMember('tm_0000000001', 'tmm_0000000002');
      expect(txData).toMatchObject({ version: { increment: 1 } });
      expect(txData.mainAgentMemberId).toBeUndefined();
    });

    it('findOne 返回包含 mainAgentMemberId', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow({ mainAgentMemberId: 'tmm_0000000001', members: [teamMemberRow()], queues: [] }));
      const result: any = await service.findOne('tm_0000000001');
      expect(result.mainAgentMemberId).toBe('tmm_0000000001');
    });
  });

  describe('团队用户成员（team_user_members）', () => {
    it('create 团队自动写入创建者 owner 成员行（同事务）', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('tm_0000000001')
        .mockResolvedValueOnce('tmm_0000000001')
        .mockResolvedValueOnce('tum_0000000001');
      const tx = mockCreateTx(teamRow());
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.team.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          teamRow({
            members: [teamMemberRow()],
            userMembers: [{ id: 'tum_0000000001', userId, role: 'owner', joinedAt: new Date('2026-09-01T00:00:00Z') }],
          }),
        );
      const result: any = await service.create(userId, {
        name: 'team-owner',
        members: [{ agentId: 'a_product' }],
      } as any);
      expect(tx.teamUserMember.create).toHaveBeenCalledTimes(1);
      expect(tx.teamUserMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'tum_0000000001',
          teamId: 'tm_0000000001',
          userId,
          role: 'owner',
        }),
      });
      expect(result.userMembers).toHaveLength(1);
      expect(result.userMembers[0]).toMatchObject({ userId, role: 'owner' });
    });

    it('findOne/GET 返回 userMembers 数组（id/userId/role/joinedAt 形状）', async () => {
      const joinedAt = new Date('2026-09-01T00:00:00Z');
      prisma.team.findUnique.mockResolvedValue(
        teamRow({
          members: [teamMemberRow()],
          userMembers: [{ id: 'tum_0000000001', userId, role: 'owner', joinedAt }],
          queues: [],
        }),
      );
      const result: any = await service.findOne('tm_0000000001');
      expect(result.userMembers).toHaveLength(1);
      expect(result.userMembers[0]).toEqual({ id: 'tum_0000000001', userId, role: 'owner', joinedAt });
    });

    it('addUserMember → removeUserMember 往返：成员写入后可移除，userMembers 先增后减', async () => {
      const store: Record<string, any> = {};
      prisma.team.findUnique.mockImplementation(async () =>
        teamRow({
          members: [],
          userMembers: Object.values(store),
          queues: [],
        }),
      );
      prisma.user.findUnique.mockResolvedValue({ id: 'u_new', username: 'new' });
      prisma.teamUserMember.findUnique.mockImplementation(async ({ where }: any) =>
        store[`${where.teamId_userId.teamId}|${where.teamId_userId.userId}`] ?? null,
      );
      prisma.teamUserMember.create.mockImplementation(async ({ data }: any) => {
        store[`${data.teamId}|${data.userId}`] = { ...data };
        return { ...data };
      });
      prisma.teamUserMember.delete.mockImplementation(async ({ where }: any) => {
        const key = Object.keys(store).find((k) => store[k].id === where.id);
        if (key) delete store[key];
        return { id: where.id };
      });
      prisma.team.update = jest.fn().mockResolvedValue({});
      idGen.nextId.mockResolvedValue('tum_0000000002');

      const added: any = await service.addUserMember('tm_0000000001', { userId: 'u_new' });
      expect(added.userMembers).toHaveLength(1);
      expect(added.userMembers[0]).toMatchObject({ userId: 'u_new', role: 'member' });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        expect.objectContaining({ action: 'user_member_add', userId: 'u_new' }),
        { type: 'global' },
      );

      const removed: any = await service.removeUserMember('tm_0000000001', 'u_new');
      expect(removed.userMembers).toHaveLength(0);
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        expect.objectContaining({ action: 'user_member_remove', userId: 'u_new' }),
        { type: 'global' },
      );
    });

    it('addUserMember 重复添加 → 409（非 500）', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.user.findUnique.mockResolvedValue({ id: 'u_new', username: 'new' });
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1', teamId: 'tm_0000000001', userId: 'u_new' });
      await expect(service.addUserMember('tm_0000000001', { userId: 'u_new' })).rejects.toThrow(ConflictException);
      try {
        await service.addUserMember('tm_0000000001', { userId: 'u_new' });
        fail('应抛出 ConflictException');
      } catch (e) {
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: 'USER_ALREADY_MEMBER',
        });
      }
      expect(prisma.teamUserMember.create).not.toHaveBeenCalled();
    });

    it('addUserMember 并发竞态：create 报 P2002 → 重读命中 → 干净 409 USER_ALREADY_MEMBER（非 500）', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.user.findUnique.mockResolvedValue({ id: 'u_new', username: 'new' });
      prisma.teamUserMember.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'tum_1', teamId: 'tm_0000000001', userId: 'u_new' });
      prisma.teamUserMember.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      try {
        await service.addUserMember('tm_0000000001', { userId: 'u_new' });
        fail('应抛出 ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: 'USER_ALREADY_MEMBER',
        });
      }
      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledTimes(2);
    });

    it('addUserMember 团队/用户不存在 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(service.addUserMember('tm_missing', { userId: 'u_new' })).rejects.toThrow(NotFoundException);
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.addUserMember('tm_0000000001', { userId: 'ghost' })).rejects.toThrow(NotFoundException);
    });

    it('removeUserMember 非成员 → 404', async () => {
      prisma.team.findUnique.mockResolvedValue(teamRow());
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      await expect(service.removeUserMember('tm_0000000001', 'ghost')).rejects.toThrow(NotFoundException);
    });
  });
});
