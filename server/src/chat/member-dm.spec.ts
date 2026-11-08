import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service';

/** P4：成员跨群私聊聚合读 + 一次全部已读。 */
describe('ChatService 成员私聊聚合（P4）', () => {
  let prisma: any;
  let service: ChatService;

  const row = (id: string, channelId: string) => ({
    id,
    channelId,
    taskId: null,
    senderType: 'user',
    senderId: 'u_1',
    senderInstanceId: null,
    content: { text: `msg-${id}`, parts: [] },
    mentions: [],
    status: 'sent',
    attachmentUrl: null,
    attachmentName: null,
    attachmentType: null,
    attachments: null,
    createdAt: new Date('2026-11-06T00:00:00Z'),
  });

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      member: { findUnique: jest.fn() },
      teamMember: { findMany: jest.fn() },
      teamUserMember: { findFirst: jest.fn() },
      chatChannel: { findMany: jest.fn(), updateMany: jest.fn() },
      message: { findMany: jest.fn() },
    };
    const dispatcher: any = {
      onLoading: jest.fn(),
      onFinal: jest.fn(),
      onError: jest.fn(),
    };
    dispatcher.onLoading.mockReturnValue(dispatcher);
    dispatcher.onFinal.mockReturnValue(dispatcher);
    dispatcher.onError.mockReturnValue(dispatcher);
    service = new ChatService(
      prisma,
      { nextId: jest.fn() } as any,
      {} as any,
      {} as any,
      dispatcher,
    );
  });

  it('聚合该成员所有 private 频道消息并按时间正序返回', async () => {
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'tm_1' }]);
    prisma.teamUserMember.findFirst.mockResolvedValue({ id: 'tum_1' });
    prisma.chatChannel.findMany.mockResolvedValue([
      { id: 'c_old' },
      { id: 'c_new' },
    ]);
    prisma.message.findMany
      .mockResolvedValueOnce([{ id: 'm_3' }, { id: 'm_2' }]) // id 页
      .mockResolvedValueOnce([row('m_3', 'c_new'), row('m_2', 'c_old')]); // 整行

    const result: any = await service.findMemberMessages('mbr_1', 'u_1', {});
    expect(prisma.message.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { channelId: { in: ['c_old', 'c_new'] } },
        orderBy: { id: 'desc' },
        take: 51,
      }),
    );
    expect(result.items.map((m: any) => m.id)).toEqual(['m_2', 'm_3']);
    expect(result.nextCursor).toBeNull();
  });

  it('member 不存在 → 404；无共享团队 → 403', async () => {
    prisma.member.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.findMemberMessages('mbr_x', 'u_1', {}),
    ).rejects.toBeInstanceOf(NotFoundException);

    prisma.member.findUnique.mockResolvedValueOnce({ id: 'mbr_1' });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'tm_1' }]);
    prisma.teamUserMember.findFirst.mockResolvedValue(null);
    await expect(
      service.findMemberMessages('mbr_1', 'u_1', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('markMemberRead：把该成员所有 private 频道置为已读', async () => {
    prisma.member.findUnique.mockResolvedValue({ id: 'mbr_1' });
    prisma.teamMember.findMany.mockResolvedValue([{ teamId: 'tm_1' }]);
    prisma.teamUserMember.findFirst.mockResolvedValue({ id: 'tum_1' });
    prisma.chatChannel.updateMany.mockResolvedValue({ count: 2 });

    const result: any = await service.markMemberRead('mbr_1', 'u_1');
    expect(prisma.chatChannel.updateMany).toHaveBeenCalledWith({
      where: { memberId: 'mbr_1', type: 'private' },
      data: { lastReadAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ memberId: 'mbr_1', updated: 2 });
  });
});
