import { BadRequestException, ConflictException } from '@nestjs/common';
import { TeamsService } from './teams.service';

/**
 * P1：建群/加成员的成员选择（D17）。
 * - memberId：引用既有成员（不新建 Member）
 * - newMember：内联新建（Member + 席位同事务）
 * - 重复入群 / 停用成员 / memberId+newMember 互斥 → 明确 4xx
 */
describe('TeamsService member selection (P1)', () => {
  let service: TeamsService;
  let prisma: any;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let tx: any;

  const userId = 'u_admin';
  const teamId = 'tm_0000000001';

  const teamRow = (overrides: Record<string, unknown> = {}) => ({
    id: teamId,
    name: 'team-alpha',
    description: null,
    reuseSession: true,
    currentTaskId: null,
    version: 0,
    createdBy: userId,
    createdAt: new Date('2026-11-06T00:00:00Z'),
    updatedAt: new Date('2026-11-06T00:00:00Z'),
    members: [],
    userMembers: [],
    ...overrides,
  });

  const memberRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'mbr_0000000001',
    name: '架构师-老周',
    status: 'active',
    agentId: 'a_architect',
    defaultRoleId: 'ar_architect',
    ...overrides,
  });

  const roleRow = {
    id: 'ar_architect',
    key: 'architect',
    name: '架构师',
    defaultAgentId: 'a_architect',
    defaultOpencodeAgentName: null,
  };

  const makeTx = () => ({
    team: {
      create: jest.fn().mockImplementation(({ data }: any) => ({ ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    teamMember: {
      create: jest.fn().mockImplementation(({ data }: any) => ({ ...data })),
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { seq: 0 } }),
    },
    teamUserMember: {
      create: jest.fn().mockImplementation(({ data }: any) => ({ ...data })),
    },
    agent: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'a_architect', name: '架构师' }),
    },
    member: {
      create: jest.fn().mockImplementation(({ data }: any) => ({ ...data })),
    },
    chatChannel: {
      create: jest.fn().mockResolvedValue({ id: 'c_0000000001' }),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ maxSeq: 0 }]),
    message: { create: jest.fn().mockResolvedValue({ id: 'm_1' }) },
  });

  beforeEach(() => {
    prisma = {
      team: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      teamMember: { findFirst: jest.fn() },
      member: { findUnique: jest.fn() },
      agentRole: { findUnique: jest.fn().mockResolvedValue(roleRow) },
      agent: { findUnique: jest.fn() },
      chatChannel: { findFirst: jest.fn().mockResolvedValue(null) },
      task: { groupBy: jest.fn().mockResolvedValue([]) },
      session: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ maxSeq: 0 }]),
    };
    let seq = 0;
    idGen = {
      nextId: jest.fn().mockImplementation(async (prefix: string) => {
        seq += 1;
        return `${prefix}_${String(seq).padStart(10, '0')}`;
      }),
      seed: jest.fn(),
    };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    tx = makeTx();
    prisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
    service = new TeamsService(
      prisma,
      idGen as any,
      realtime as any,
      { listAgents: jest.fn().mockResolvedValue([]) } as any,
      { assignWorker: jest.fn().mockResolvedValue(null) } as any,
    );
  });

  it('create + memberId：使用成员的 Agent/岗位，席位写 memberId', async () => {
    prisma.team.findUnique
      .mockResolvedValueOnce(null) // 名称查重
      .mockResolvedValueOnce(teamRow()); // findOne
    prisma.member.findUnique.mockResolvedValue(memberRow());

    await service.create(userId, {
      name: 'team-alpha',
      members: [{ memberId: 'mbr_0000000001' }],
    } as any);

    expect(tx.member.create).not.toHaveBeenCalled();
    expect(tx.teamMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teamId,
        memberId: 'mbr_0000000001',
        agentId: 'a_architect',
        roleId: 'ar_architect',
        alias: '架构师-老周',
      }),
    });
  });

  it('create + newMember：Member 与席位同事务创建，createdBy=操作者', async () => {
    prisma.team.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(teamRow());

    await service.create(userId, {
      name: 'team-alpha',
      members: [
        {
          newMember: {
            name: '新来的架构师',
            roleId: 'ar_architect',
            privateWorkDir: '~/work/new-arch',
          },
        },
      ],
    } as any);

    expect(tx.member.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: '新来的架构师',
        defaultRoleId: 'ar_architect',
        agentId: 'a_architect',
        privateWorkDir: '~/work/new-arch',
        createdBy: userId,
        status: 'active',
      }),
    });
    expect(tx.teamMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberId: expect.stringMatching(/^mbr_/),
        agentId: 'a_architect',
        roleId: 'ar_architect',
      }),
    });
  });

  it('create：memberId + newMember 同时给出 → 400 MEMBER_SELECTION_CONFLICT', async () => {
    prisma.team.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.create(userId, {
        name: 'team-alpha',
        members: [
          {
            memberId: 'mbr_0000000001',
            newMember: { name: 'x', roleId: 'ar_architect' },
          },
        ],
      } as any),
    ).rejects.toMatchObject({
      response: { code: 'MEMBER_SELECTION_CONFLICT' },
    });
  });

  it('create：成员已停用 → 400 MEMBER_DISABLED', async () => {
    prisma.team.findUnique.mockResolvedValueOnce(null);
    prisma.member.findUnique.mockResolvedValue(
      memberRow({ status: 'disabled' }),
    );

    await expect(
      service.create(userId, {
        name: 'team-alpha',
        members: [{ memberId: 'mbr_0000000001' }],
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create：同一成员重复入群 → 409 MEMBER_ALREADY_IN_TEAM', async () => {
    prisma.team.findUnique.mockResolvedValueOnce(null);
    prisma.member.findUnique.mockResolvedValue(memberRow());
    tx.teamMember.findFirst.mockResolvedValue({ id: 'tmm_existing' });

    await expect(
      service.create(userId, {
        name: 'team-alpha',
        members: [{ memberId: 'mbr_0000000001' }],
      } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('addMember + memberId：席位写 memberId 并生成群系统消息', async () => {
    prisma.team.findUnique
      .mockResolvedValueOnce(teamRow()) // addMember 初始团队查询
      .mockResolvedValueOnce(teamRow()); // findOne
    prisma.member.findUnique.mockResolvedValue(memberRow());
    prisma.agent.findUnique.mockResolvedValue({
      id: 'a_architect',
      name: '架构师',
    });
    prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });

    await service.addMember(
      teamId,
      { memberId: 'mbr_0000000001' } as any,
      userId,
    );

    expect(tx.teamMember.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teamId,
        memberId: 'mbr_0000000001',
        agentId: 'a_architect',
        roleId: 'ar_architect',
      }),
    });
    expect(tx.message.create).toHaveBeenCalled();
  });
});
