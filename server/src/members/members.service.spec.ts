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
    teamMember: { count: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const idGen = {
    nextId: jest.fn().mockResolvedValue('mbr_0000000001'),
    seed: jest.fn(),
  };
  const service = new MembersService(prisma, idGen as any);
  return { service, prisma, idGen };
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

  it('remove：仍有席位 → 409 MEMBER_IN_USE，且不删除', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.teamMember.count.mockResolvedValue(2);

    await expect(service.remove('mbr_1')).rejects.toMatchObject({
      response: { code: 'MEMBER_IN_USE' },
    });
    expect(prisma.member.delete).not.toHaveBeenCalled();
  });

  it('remove：无席位 → 删除', async () => {
    const { service, prisma } = createService();
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.teamMember.count.mockResolvedValue(0);
    prisma.member.delete.mockResolvedValue({ id: 'mbr_1' });

    await expect(service.remove('mbr_1')).resolves.toEqual({
      deleted: true,
      id: 'mbr_1',
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
});
