import { ChatService } from './chat.service';

/**
 * P3：SESSION_SCOPE=member 时，触发解析优先成员全局会话；旧席位回落原席位会话。
 * 这里直接测 buildTrigger（resolveMentions 的单成员入口），覆盖开关两态。
 */
describe('ChatService.buildTrigger · 成员全局会话（P3）', () => {
  const original = process.env.SESSION_SCOPE;
  let prisma: any;
  let sessionLifecycle: any;
  let service: ChatService;

  beforeEach(() => {
    prisma = {
      session: { findFirst: jest.fn() },
    };
    const dispatcher: any = {
      onLoading: jest.fn(),
      onFinal: jest.fn(),
      onError: jest.fn(),
    };
    dispatcher.onLoading.mockReturnValue(dispatcher);
    dispatcher.onFinal.mockReturnValue(dispatcher);
    dispatcher.onError.mockReturnValue(dispatcher);
    sessionLifecycle = {
      ensureMemberSession: jest
        .fn()
        .mockResolvedValue({ id: 's_member', reused: false }),
    };
    service = new ChatService(
      prisma,
      { nextId: jest.fn() } as any,
      {} as any,
      {} as any,
      dispatcher,
      sessionLifecycle,
    );
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SESSION_SCOPE;
    else process.env.SESSION_SCOPE = original;
  });

  const row = {
    id: 'tmm_1',
    agentId: 'a_arch',
    removedAt: null,
    enabled: true,
    memberId: 'mbr_1',
  };

  it('member 模式：用 ensureMemberSession，不再查席位会话', async () => {
    process.env.SESSION_SCOPE = 'member';
    const result = await (service as any).buildTrigger('tm_1', row);

    expect(sessionLifecycle.ensureMemberSession).toHaveBeenCalledWith('mbr_1', {
      seatId: 'tmm_1',
      teamId: 'tm_1',
    });
    expect(prisma.session.findFirst).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sessionId: 's_member',
      instanceId: 'tmm_1',
      status: 'dispatched',
    });
  });

  it('member 模式下旧席位（无 memberId）回落席位会话', async () => {
    process.env.SESSION_SCOPE = 'member';
    prisma.session.findFirst.mockResolvedValue({ id: 's_seat' });

    const result = await (service as any).buildTrigger('tm_1', {
      ...row,
      memberId: null,
    });

    expect(sessionLifecycle.ensureMemberSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sessionId: 's_seat', status: 'dispatched' });
  });

  it('member 解析失败（成员停用等）回落席位会话，不阻断派发', async () => {
    process.env.SESSION_SCOPE = 'member';
    sessionLifecycle.ensureMemberSession.mockRejectedValue(
      new Error('disabled'),
    );
    prisma.session.findFirst.mockResolvedValue({ id: 's_seat' });

    const result = await (service as any).buildTrigger('tm_1', row);

    expect(result).toMatchObject({ sessionId: 's_seat', status: 'dispatched' });
  });

  it('seat 模式（默认）：保持原席位会话查询', async () => {
    delete process.env.SESSION_SCOPE;
    prisma.session.findFirst.mockResolvedValue({ id: 's_seat' });

    await (service as any).buildTrigger('tm_1', row);

    expect(sessionLifecycle.ensureMemberSession).not.toHaveBeenCalled();
    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: { teamId: 'tm_1', teamMemberId: 'tmm_1' },
      select: { id: true },
    });
  });
});
