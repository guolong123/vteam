import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { MembersService } from './members.service';

/**
 * MembersService 单元测试（P0）。
 * Prisma/IdGenerator 全部 mock，验证：建群形状之外的成员 CRUD 语义——
 * 岗位默认 Agent 解析、名称冲突、无席位才可删、列表投影、克隆命名。
 */
function createService() {
  const prisma: any = {
    member: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    agentRole: { findUnique: jest.fn() },
    agent: { findUnique: jest.fn() },
    model: { findUnique: jest.fn() },
    worker: { findUnique: jest.fn() },
    teamMember: {
      count: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    session: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    notificationChannel: { findMany: jest.fn().mockResolvedValue([]) },
    memberNotificationChannel: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    teamNotificationChannel: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  };
  const idGen = {
    nextId: jest.fn().mockResolvedValue('mbr_0000000001'),
    seed: jest.fn(),
  };
  const sessionLifecycle = { resetMemberSession: jest.fn() };
  const service = new MembersService(
    prisma,
    idGen as any,
    sessionLifecycle as any,
  );
  return { service, prisma, idGen, sessionLifecycle };
}

const detailRow = {
  id: 'mbr_0000000001',
  name: '架构师-老周',
  status: 'active',
  description: null,
  privateWorkDir: '~/work/laozhou',
  defaultRoleId: 'ar_architect',
  agentId: 'a_architect',
  defaultModelId: null,
  preferredWorkerId: null,
  role: { id: 'ar_architect', key: 'architect', name: '架构师' },
  agent: { id: 'a_architect', name: '架构师', agentKey: 'architect' },
  defaultModel: null,
  preferredWorker: null,
  _count: { teamMembers: 2, notificationLinks: 1 },
  teamMembers: [],
  notificationLinks: [],
  createdAt: new Date('2026-11-06T00:00:00Z'),
  updatedAt: new Date('2026-11-06T00:00:00Z'),
};

describe('MembersService', () => {
  it('create：agentId 缺省取岗位 defaultAgentId，落库并返回详情', async () => {
    const { service, prisma, idGen } = createService();
    prisma.agentRole.findUnique.mockResolvedValue({
      id: 'ar_architect',
      defaultAgentId: 'a_architect',
    });
    prisma.agent.findUnique.mockResolvedValue({ id: 'a_architect' });
    prisma.member.create.mockResolvedValue({ id: 'mbr_0000000001' });
    prisma.member.findUnique.mockResolvedValue(detailRow);

    const result = await service.create('u_1', {
      name: '  架构师-老周 ',
      roleId: 'ar_architect',
    });

    expect(idGen.nextId).toHaveBeenCalledWith('mbr');
    expect(prisma.member.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'mbr_0000000001',
        name: '架构师-老周',
        defaultRoleId: 'ar_architect',
        agentId: 'a_architect',
        status: 'active',
        createdBy: 'u_1',
      }),
    });
    expect(result).toMatchObject({
      id: 'mbr_0000000001',
      name: '架构师-老周',
      groupCount: 2,
      notificationChannelCount: 1,
    });
  });

  it('create：岗位无默认 Agent 且未显式提供 → 400 MEMBER_AGENT_REQUIRED', async () => {
    const { service, prisma } = createService();
    prisma.agentRole.findUnique.mockResolvedValue({
      id: 'ar_architect',
      defaultAgentId: null,
    });

    await expect(
      service.create('u_1', { name: '无 Agent', roleId: 'ar_architect' }),
    ).rejects.toMatchObject({
      response: { code: 'MEMBER_AGENT_REQUIRED' },
    });
  });

  it('create：重名（P2002）→ 409 MEMBER_NAME_CONFLICT', async () => {
    const { service, prisma } = createService();
    prisma.agentRole.findUnique.mockResolvedValue({
      id: 'ar_architect',
      defaultAgentId: 'a_architect',
    });
    prisma.agent.findUnique.mockResolvedValue({ id: 'a_architect' });
    prisma.member.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.create('u_1', { name: '重名', roleId: 'ar_architect' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('remove：仍有席位且未带 cascadeSeats → 409 MEMBER_IN_USE（details 带可级联提示），且不删除', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.teamMember.findMany.mockResolvedValue([
      { id: 'tmm_1', teamId: 'tm_1', team: { id: 'tm_1', name: '群A' } },
      { id: 'tmm_2', teamId: 'tm_2', team: { id: 'tm_2', name: '群B' } },
    ]);

    await expect(service.remove('mbr_1')).rejects.toMatchObject({
      response: {
        code: 'MEMBER_IN_USE',
        details: {
          seatCount: 2,
          canCascade: true,
          teams: [
            { id: 'tm_1', name: '群A' },
            { id: 'tm_2', name: '群B' },
          ],
        },
      },
    });
    expect(prisma.member.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('remove：无席位 → 直接删除，removedSeats 为空', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.teamMember.findMany.mockResolvedValue([]);
    prisma.member.delete.mockResolvedValue({ id: 'mbr_1' });
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));

    await expect(service.remove('mbr_1')).resolves.toEqual({
      deleted: true,
      id: 'mbr_1',
      removedSeats: [],
    });
  });

  it('remove：cascadeSeats=true → 同事务内先移出全部席位再删成员，并回报移出的群聊', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.teamMember.findMany.mockResolvedValue([
      { id: 'tmm_1', teamId: 'tm_1', team: { id: 'tm_1', name: '群A' } },
      { id: 'tmm_2', teamId: 'tm_2', team: { id: 'tm_2', name: '群B' } },
    ]);
    prisma.teamMember.deleteMany.mockResolvedValue({ count: 2 });
    prisma.member.delete.mockResolvedValue({ id: 'mbr_1' });
    prisma.team = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    prisma.chatChannel = {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    prisma.taskGroupInstance = {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    prisma.session.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));

    const result = await service.remove('mbr_1', { cascadeSeats: true });

    expect(result).toEqual({
      deleted: true,
      id: 'mbr_1',
      removedSeats: [
        { teamId: 'tm_1', teamName: '群A' },
        { teamId: 'tm_2', teamName: '群B' },
      ],
    });
    // 席位解绑（与 TeamsService.removeMember 同口径）先于删成员
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { teamMemberId: { in: ['tmm_1', 'tmm_2'] } },
      data: { teamMemberId: null },
    });
    expect(prisma.chatChannel.updateMany).toHaveBeenCalled();
    expect(prisma.taskGroupInstance.updateMany).toHaveBeenCalled();
    expect(prisma.team.updateMany).toHaveBeenCalledWith({
      where: { mainAgentMemberId: { in: ['tmm_1', 'tmm_2'] } },
      data: { mainAgentMemberId: null },
    });
    expect(prisma.teamMember.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['tmm_1', 'tmm_2'] } },
    });
    expect(prisma.member.delete).toHaveBeenCalledWith({
      where: { id: 'mbr_1' },
    });
  });

  it('findOne：不存在 → 404 MEMBER_NOT_FOUND', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue(null);

    await expect(service.findOne('mbr_missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('findAll：关键字/状态过滤 + 分页投影', async () => {
    const { service, prisma } = createService();
    prisma.$transaction.mockResolvedValue([
      1,
      [
        {
          ...detailRow,
          _count: { teamMembers: 2, notificationLinks: 0 },
        },
      ],
    ]);

    const result = await service.findAll({
      keyword: ' 老周 ',
      status: 'active',
      page: 2,
      pageSize: 10,
    });

    expect(prisma.member.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: 'active',
        OR: [
          { name: { contains: '老周' } },
          { agent: { name: { contains: '老周' } } },
        ],
      }),
    });
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(result.items[0]).toMatchObject({
      id: 'mbr_0000000001',
      groupCount: 2,
    });
  });

  it('update：名称冲突 → 409；引用不存在 → 400', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1', name: 'old' });
    prisma.member.update.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.update('mbr_1', { name: 'dup' }),
    ).rejects.toBeInstanceOf(ConflictException);

    prisma.member.update.mockResolvedValue({});
    prisma.agent.findUnique.mockResolvedValue(null);
    await expect(
      service.update('mbr_1', { agentId: 'a_missing' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rename：成员改名时同步旧成员名的席位别名', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1', name: '旧名' });
    prisma.member.update.mockResolvedValue({});
    await service.update('mbr_1', { name: '新名' });
    expect(prisma.teamMember.updateMany).toHaveBeenCalledWith({
      where: { memberId: 'mbr_1', alias: '旧名' },
      data: { alias: '新名' },
    });
  });

  it('resetSession：成员不存在 → 404；存在则委托生命周期重置', async () => {
    const { service, prisma, sessionLifecycle } = createService();
    prisma.member.findUnique.mockResolvedValueOnce(null);
    await expect(service.resetSession('mbr_x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.member.findUnique.mockResolvedValueOnce({ id: 'mbr_1' });
    sessionLifecycle.resetMemberSession.mockResolvedValue({
      reset: 1,
      sessionId: 's_new',
    });
    await expect(service.resetSession('mbr_1')).resolves.toEqual({
      reset: 1,
      sessionId: 's_new',
    });
    expect(sessionLifecycle.resetMemberSession).toHaveBeenCalledWith('mbr_1', {
      reason: 'member_manual_reset',
    });
  });

  it('bindNotificationChannels：无冲突 → replace-all 绑定', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.notificationChannel.findMany.mockResolvedValue([
      { id: 'nc_1' },
      { id: 'nc_2' },
    ]);
    prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));

    const result: any = await service.bindNotificationChannels('mbr_1', [
      'nc_1',
      'nc_2',
    ]);
    expect(result).toEqual({
      memberId: 'mbr_1',
      notificationChannelIds: ['nc_1', 'nc_2'],
    });
    expect(prisma.memberNotificationChannel.createMany).toHaveBeenCalledWith({
      data: [
        { memberId: 'mbr_1', notificationChannelId: 'nc_1' },
        { memberId: 'mbr_1', notificationChannelId: 'nc_2' },
      ],
      skipDuplicates: true,
    });
  });

  it('bindNotificationChannels：渠道被团队占用 → 409；replaceExisting 转移归属', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.notificationChannel.findMany.mockResolvedValue([{ id: 'nc_1' }]);
    prisma.teamNotificationChannel.findMany.mockResolvedValue([
      { teamId: 'tm_1', notificationChannelId: 'nc_1' },
    ]);

    await expect(
      service.bindNotificationChannels('mbr_1', ['nc_1']),
    ).rejects.toMatchObject({
      response: { code: 'CHANNEL_ALREADY_BOUND' },
    });

    prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));
    await service.bindNotificationChannels('mbr_1', ['nc_1'], true);
    expect(prisma.teamNotificationChannel.deleteMany).toHaveBeenCalledWith({
      where: { notificationChannelId: { in: ['nc_1'] } },
    });
  });
});
