import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service';

/**
 * POST /dm-channels 成员形状（P2）：{ memberId } → 解析席位/上下文团队，
 * 复用或创建 private 频道并落 member_id。
 */
describe('ChatService.createDmChannel (memberId)', () => {
  let service: ChatService;
  let prisma: any;
  const dispatcher: any = {
    onLoading: jest.fn(),
    onFinal: jest.fn(),
    onError: jest.fn(),
  };
  dispatcher.onLoading.mockReturnValue(dispatcher);
  dispatcher.onFinal.mockReturnValue(dispatcher);
  dispatcher.onError.mockReturnValue(dispatcher);

  const channelRow = {
    id: 'c_0000000001',
    type: 'private',
    teamId: 'tm_1',
    memberId: 'mbr_1',
    teamMemberId: 'tmm_1',
    taskId: null,
    agentId: 'a_architect',
    pinned: false,
    lastReadAt: null,
    createdAt: new Date('2026-11-06T00:00:00Z'),
  };

  beforeEach(() => {
    prisma = {
      member: { findUnique: jest.fn() },
      teamMember: {
        findMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          id: 'tmm_1',
          agentId: 'a_architect',
          teamId: 'tm_1',
          memberId: 'mbr_1',
        }),
      },
      team: { findUnique: jest.fn().mockResolvedValue({ id: 'tm_1' }) },
      chatChannel: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(channelRow),
        update: jest.fn().mockResolvedValue(channelRow),
      },
    };
    service = new ChatService(
      prisma,
      { nextId: jest.fn().mockResolvedValue('c_0000000001') } as any,
      { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) } as any,
      {} as any,
      dispatcher,
    );
  });

  it('memberId + 单个席位：创建频道并写 memberId', async () => {
    prisma.member.findUnique.mockResolvedValue({
      id: 'mbr_1',
      name: '架构师-老周',
      status: 'active',
    });
    prisma.teamMember.findMany.mockResolvedValue([
      { id: 'tmm_1', agentId: 'a_architect', teamId: 'tm_1' },
    ]);

    const result: any = await service.createDmChannel('u_1', {
      memberId: 'mbr_1',
    } as any);

    expect(prisma.chatChannel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'private',
        teamId: 'tm_1',
        memberId: 'mbr_1',
        teamMemberId: 'tmm_1',
      }),
      include: expect.anything(),
    });
    expect(result).toMatchObject({ id: 'c_0000000001', memberId: 'mbr_1' });
  });

  it('已有频道缺 member_id：update 补齐后返回', async () => {
    prisma.member.findUnique.mockResolvedValue({
      id: 'mbr_1',
      name: '架构师-老周',
      status: 'active',
    });
    prisma.teamMember.findMany.mockResolvedValue([
      { id: 'tmm_1', agentId: 'a_architect', teamId: 'tm_1' },
    ]);
    prisma.chatChannel.findFirst.mockResolvedValue({
      ...channelRow,
      memberId: null,
    });

    await service.createDmChannel('u_1', { memberId: 'mbr_1' } as any);

    expect(prisma.chatChannel.update).toHaveBeenCalledWith({
      where: { id: 'c_0000000001' },
      data: { memberId: 'mbr_1' },
      include: expect.anything(),
    });
  });

  it('旧形状（teamId+teamMemberId）但席位已挂 member_id → 复用成员唯一私聊频道', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm_2' });
    prisma.teamMember.findUnique.mockResolvedValue({
      id: 'tmm_2',
      agentId: 'a_architect',
      teamId: 'tm_2',
      memberId: 'mbr_1',
    });
    prisma.chatChannel.findFirst.mockResolvedValue({
      ...channelRow,
      teamId: 'tm_1',
    });

    const result: any = await service.createDmChannel('u_1', {
      teamId: 'tm_2',
      teamMemberId: 'tmm_2',
    } as any);

    expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
      where: { memberId: 'mbr_1', type: 'private' },
      orderBy: { createdAt: 'asc' },
      include: expect.anything(),
    });
    expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    expect(result.teamId).toBe('tm_1');
  });

  it('成员停用 → 400 MEMBER_DISABLED', async () => {
    prisma.member.findUnique.mockResolvedValue({
      id: 'mbr_1',
      name: 'x',
      status: 'disabled',
    });

    await expect(
      service.createDmChannel('u_1', { memberId: 'mbr_1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('成员不在任何群 → 400 MEMBER_NOT_IN_ANY_TEAM', async () => {
    prisma.member.findUnique.mockResolvedValue({
      id: 'mbr_1',
      name: 'x',
      status: 'active',
    });
    prisma.teamMember.findMany.mockResolvedValue([]);

    await expect(
      service.createDmChannel('u_1', { memberId: 'mbr_1' } as any),
    ).rejects.toMatchObject({
      response: { code: 'MEMBER_NOT_IN_ANY_TEAM' },
    });
  });

  it('成员不存在 → 404 MEMBER_NOT_FOUND', async () => {
    prisma.member.findUnique.mockResolvedValue(null);
    await expect(
      service.createDmChannel('u_1', { memberId: 'mbr_x' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
