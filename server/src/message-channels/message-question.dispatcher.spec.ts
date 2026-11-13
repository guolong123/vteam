import {
  MessageQuestionDispatcher,
  buildQuestionFallbackText,
} from './message-question.dispatcher';

/**
 * 回归背景（P0，生产事故 aq_0000000478）：
 * 托管团队里主 Agent 自己触发 `external_directory` 权限 → 调度器「托管自环」分支委托发
 * 企微卡片，但渠道解析只查 `task_message_channels`，而团队直聊的 taskId 是 `team:<teamId>`
 * 占位 ⇒ 0 渠道 ⇒ 卡片静默丢弃 ⇒ 企微侧零通知、会话挂死 3.5 小时。
 *
 * 本 spec 锁定三件事：
 * 1. `team:<id>` 必须走 `team_message_channels`（团队绑定），不再误查任务绑定；
 * 2. 任务域（真实 taskId）行为不变，仍查任务绑定；
 * 3. 卡片发不出去时有纯文本兜底（不让用户侧完全无感），且投递结果可判定。
 */
describe('MessageQuestionDispatcher 问题/权限卡片投递', () => {
  let dispatcher: MessageQuestionDispatcher;
  let prisma: {
    taskMessageChannel: { findMany: jest.Mock };
    teamMessageChannel: { findMany: jest.Mock };
    messageChannel: { findMany: jest.Mock };
    agentQuestion: { findUnique: jest.Mock };
    memberMessageChannel: { findMany: jest.Mock };
    session: { findUnique: jest.Mock };
    teamMember: { findUnique: jest.Mock };
  };
  let adapter: { sendQuestionCard: jest.Mock; sendNewMessage: jest.Mock };
  let delivery: { log: jest.Mock; finish: jest.Mock };
  let registry: { get: jest.Mock };

  const permissionQuestion = {
    id: 'aq_0000000478',
    requestId: 'per_1a4af194c001',
    kind: 'permission',
    content: {
      title: 'external_directory',
      pattern:
        '/data/vteam-worker/repos/keta-skills/skills/xishu-cloudstack/scripts/*',
    },
  };

  const bindTeamChannel = () => {
    prisma.teamMessageChannel.findMany.mockResolvedValue([
      { messageChannelId: 'mc_0000000006' },
    ]);
    prisma.messageChannel.findMany.mockResolvedValue([
      {
        id: 'mc_0000000006',
        type: 'wecom_aibot',
        enabled: true,
        config: { lastChatid: 'u_1' },
      },
    ]);
  };

  beforeEach(() => {
    prisma = {
      taskMessageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      teamMessageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      messageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      agentQuestion: { findUnique: jest.fn().mockResolvedValue(null) },
      // 成员级渠道绑定（2026-11-13）：默认无
      memberMessageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      session: { findUnique: jest.fn().mockResolvedValue(null) },
      teamMember: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    adapter = {
      sendQuestionCard: jest.fn().mockResolvedValue({ externalId: 'req_1' }),
      sendNewMessage: jest.fn().mockResolvedValue(true),
    };
    delivery = {
      log: jest.fn().mockResolvedValue({ id: 'md_1' }),
      finish: jest.fn().mockResolvedValue(undefined),
    };
    registry = { get: jest.fn().mockReturnValue(adapter) };
    dispatcher = new MessageQuestionDispatcher(
      { subscribe: jest.fn(() => () => {}) } as any,
      prisma as any,
      registry as any,
      delivery as any,
    );
  });

  it('team:<teamId> → 走团队绑定（team_message_channels）发权限卡片', async () => {
    bindTeamChannel();

    const ok = await dispatcher.dispatchQuestionCard(
      'team:tm_0000000006',
      permissionQuestion,
    );

    expect(ok).toBe(true);
    expect(prisma.teamMessageChannel.findMany).toHaveBeenCalledWith({
      where: { teamId: 'tm_0000000006' },
      select: { messageChannelId: true },
    });
    expect(prisma.taskMessageChannel.findMany).not.toHaveBeenCalled();
    expect(adapter.sendQuestionCard).toHaveBeenCalledTimes(1);
    const [resolvedChannel, question] = adapter.sendQuestionCard.mock
      .calls[0] as any[];
    expect(resolvedChannel.id).toBe('mc_0000000006');
    expect(question.id).toBe('aq_0000000478');
    expect(adapter.sendNewMessage).not.toHaveBeenCalled();
  });

  it('任务域 taskId 行为不变：查 task_message_channels，不查团队绑定', async () => {
    prisma.taskMessageChannel.findMany.mockResolvedValue([
      { messageChannelId: 'mc_9' },
    ]);
    prisma.messageChannel.findMany.mockResolvedValue([
      { id: 'mc_9', type: 'wecom_aibot', enabled: true, config: {} },
    ]);

    const ok = await dispatcher.dispatchQuestionCard(
      't_0000000024',
      permissionQuestion,
    );

    expect(ok).toBe(true);
    expect(prisma.taskMessageChannel.findMany).toHaveBeenCalledWith({
      where: { taskId: 't_0000000024' },
      select: { messageChannelId: true },
    });
    expect(prisma.teamMessageChannel.findMany).not.toHaveBeenCalled();
  });

  it('无绑定渠道 → 返回 false 且不发任何消息', async () => {
    const ok = await dispatcher.dispatchQuestionCard(
      'team:tm_0000000006',
      permissionQuestion,
    );

    expect(ok).toBe(false);
    expect(adapter.sendQuestionCard).not.toHaveBeenCalled();
    expect(adapter.sendNewMessage).not.toHaveBeenCalled();
  });

  it('卡片发送失败 → 纯文本兜底（企微侧至少知道要去处理权限）', async () => {
    bindTeamChannel();
    adapter.sendQuestionCard.mockRejectedValue(
      new Error('wecom sendMessage failed errcode=40008'),
    );

    const ok = await dispatcher.dispatchQuestionCard(
      'team:tm_0000000006',
      permissionQuestion,
    );

    expect(ok).toBe(true);
    expect(adapter.sendNewMessage).toHaveBeenCalledTimes(1);
    const [channelId, text] = adapter.sendNewMessage.mock.calls[0] as string[];
    expect(channelId).toBe('mc_0000000006');
    expect(text).toContain('【权限请求】external_directory');
    expect(text).toContain('请前往 Web / opencode 页面处理');
    expect(delivery.log).toHaveBeenCalledWith(
      'outbound',
      'question_card_fallback',
      'ok',
      expect.anything(),
    );
  });

  it('卡片与文本兜底都失败 → 返回 false（调用方可记告警）', async () => {
    bindTeamChannel();
    adapter.sendQuestionCard.mockRejectedValue(new Error('errcode 40008'));
    adapter.sendNewMessage.mockResolvedValue(false);

    const ok = await dispatcher.dispatchQuestionCard(
      'team:tm_0000000006',
      permissionQuestion,
    );

    expect(ok).toBe(false);
    expect(delivery.log).toHaveBeenCalledWith(
      'outbound',
      'question_card_fallback',
      'failed',
      expect.anything(),
    );
  });

  it('handle：团队域非托管问题（taskId=team:<id>）直接发卡片到团队渠道', async () => {
    bindTeamChannel();

    await dispatcher.handle({
      type: 'agent.question',
      payload: {
        question: {
          id: 'aq_1',
          requestId: 'per_1',
          taskId: 'team:tm_0000000006',
          kind: 'permission',
          content: { title: 'external_directory' },
          status: 'pending',
        },
      },
    } as any);
    // handle 内为 fire-and-forget，等一拍让投递链路跑完
    await new Promise((r) => setTimeout(r, 10));

    expect(adapter.sendQuestionCard).toHaveBeenCalledTimes(1);
  });
});

describe('buildQuestionFallbackText', () => {
  it('permission：标题 + pattern + 去向提示', () => {
    expect(
      buildQuestionFallbackText({
        kind: 'permission',
        content: { title: 'external_directory', pattern: '/a/*' },
      }),
    ).toBe(
      '【权限请求】external_directory - /a/*（请前往 Web / opencode 页面处理）',
    );
  });

  it('多问题只报数量，避免刷屏', () => {
    expect(
      buildQuestionFallbackText({
        kind: 'question',
        content: { questions: [{}, {}, {}] },
      }),
    ).toBe('【待确认】3 个问题待处理，请前往 Web 处理');
  });

  it('单问题带题面', () => {
    expect(
      buildQuestionFallbackText({
        kind: 'question',
        content: { questions: [{ question: '用哪个模板？' }] },
      }),
    ).toBe('【待确认】用哪个模板？（请前往 Web 处理）');
  });
});

/**
 * 成员级渠道回落（2026-11-13 用户反馈）
 *
 * 渠道绑定到成员后消息直达成员私聊；该成员在私聊里触发 question 时，
 * 卡片也要推到他绑定的企微渠道 —— 否则企微端完全看不到弹窗。
 */
describe('MessageQuestionDispatcher 成员级渠道回落', () => {
  const build = () => {
    const prisma: any = {
      taskMessageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      teamMessageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      messageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      agentQuestion: { findUnique: jest.fn().mockResolvedValue(null) },
      memberMessageChannel: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ messageChannelId: 'mc_member_1' }]),
      },
      session: {
        findUnique: jest.fn().mockResolvedValue({ teamMemberId: 'tmm_1' }),
      },
      teamMember: {
        findUnique: jest.fn().mockResolvedValue({ memberId: 'mbr_1' }),
      },
    };
    const adapter = {
      sendQuestionCard: jest.fn().mockResolvedValue({ externalId: 'req_1' }),
      sendNewMessage: jest.fn().mockResolvedValue(true),
    };
    const dispatcher = new MessageQuestionDispatcher(
      { subscribe: jest.fn(() => () => {}) } as any,
      prisma,
      { get: jest.fn().mockReturnValue(adapter) } as any,
      { log: jest.fn(), finish: jest.fn() } as any,
    );
    return { dispatcher, prisma, adapter };
  };

  it('团队无绑定 + 有 sessionId → 按成员绑定解析渠道并送达', async () => {
    const { dispatcher, prisma } = build();
    prisma.messageChannel.findMany.mockResolvedValue([
      { id: 'mc_member_1', type: 'wecom_aibot', enabled: true, config: {} },
    ]);

    const ok = await dispatcher.dispatchQuestionCard('team:tm_1', {
      id: 'aq_1',
      kind: 'question',
      content: { questions: [] },
      sessionId: 's_1',
    });

    expect(prisma.memberMessageChannel.findMany).toHaveBeenCalledWith({
      where: { memberId: 'mbr_1' },
      select: { messageChannelId: true },
    });
    expect(ok).toBe(true);
  });

  it('无 sessionId 时不查成员绑定（团队/任务路径不变）', async () => {
    const { dispatcher, prisma } = build();
    await dispatcher.dispatchQuestionCard('team:tm_1', {
      id: 'aq_2',
      kind: 'question',
      content: { questions: [] },
    });
    expect(prisma.memberMessageChannel.findMany).not.toHaveBeenCalled();
  });
});
