import { EVENT_TYPES } from '../common/constants/event.constants';
import type { RealtimeEvent } from '../realtime/realtime.service';
import { createLedger, embedLedger } from './review-round-ledger';
import { ReviewVerdictListener } from './review-verdict.listener';

/**
 * verdict 聚合器（inbound 半边）：只断言提取 + 定位 + 委托，
 * 收敛/翻转/通知语义一律由门层拥有，本文件只 mock 门层。
 */

const TASK = 't_0000000001';
const TEAM = 'tm_0000000001';
const CHANNEL = 'ch_0000000001';
const HOST_ISSUE = 'is_0000000007';
const MEMBER = 'tmm_0000000012';
const PLANNER = 'tmm_0000000001';
const PM = 'tmm_0000000002';

const ledgerDescription = () =>
  embedLedger(
    '评审派发 R2（v0.3，架构/开发/测试三视角）',
    createLedger({
      round: 2,
      planVersion: { version: 'v0.3', lines: 233, hash: 'a1b2c3d4' },
      taskId: TASK,
      issueId: HOST_ISSUE,
      expected: [MEMBER, 'tmm_0000000009', 'tmm_0000000010'],
      timeoutAt: '2026-09-16T00:40:00Z',
    }),
  );

const setup = (opts?: { withLedger?: boolean }) => {
  const withLedger = opts?.withLedger ?? true;
  const prisma: any = {
    issue: {
      findMany: jest.fn(async () =>
        withLedger
          ? [{ id: HOST_ISSUE, description: ledgerDescription() }]
          : [{ id: 'is_plain', description: '普通需求，无账本' }],
      ),
    },
    task: {
      findUnique: jest.fn(async () => ({ teamId: TEAM })),
    },
    team: {
      findUnique: jest.fn(async () => ({ mainAgentMemberId: PM })),
    },
    teamMember: {
      findFirst: jest.fn(async () => ({ id: PLANNER })),
    },
    chatChannel: {
      findUnique: jest.fn(async () => ({ taskId: TASK })),
    },
    message: {
      findUnique: jest.fn(async () => null),
    },
  };
  const gate = {
    recordVerdict: jest.fn(async () => ({
      outcome: 'received',
      ledger: {},
      converged: false,
    })),
  };
  const realtime: any = { subscribe: jest.fn(() => () => undefined) };
  const listener = new ReviewVerdictListener(realtime, prisma, gate as never);
  return { prisma, gate, realtime, listener };
};

const chatEvent = (message: Record<string, any>): RealtimeEvent =>
  ({
    id: 'ev_0000000001',
    type: EVENT_TYPES.CHAT_MESSAGE_NEW,
    payload: { message },
    timestamp: new Date().toISOString(),
    scopeType: 'channel',
    scopeId: CHANNEL,
  }) as RealtimeEvent;

const agentMessage = (text: string) => ({
  id: 'm_0000000540',
  channelId: CHANNEL,
  taskId: TASK,
  senderType: 'agent',
  senderId: 'a_architect',
  senderInstanceId: MEMBER,
  content: { text, parts: [] },
  status: 'sent',
});

describe('ReviewVerdictListener', () => {
  it('APPROVE 带版本 → recordVerdict 精确入参（issueId + input + notify）', async () => {
    const { gate, listener } = setup();
    await listener.handle(
      chatEvent(agentMessage('VERDICT: APPROVE @ v0.3\n依据：设计一致')),
    );
    expect(gate.recordVerdict).toHaveBeenCalledTimes(1);
    expect(gate.recordVerdict).toHaveBeenCalledWith(
      HOST_ISSUE,
      {
        member: MEMBER,
        verdict: 'APPROVE',
        msgId: 'm_0000000540',
        version: 'v0.3',
      },
      {
        channelId: CHANNEL,
        plannerMemberId: PLANNER,
        pmMemberId: PM,
        taskId: TASK,
        teamId: TEAM,
      },
    );
  });

  it('REJECT 变体（小写 + parts 文本）→ 转大写 verdict', async () => {
    const { gate, listener } = setup();
    await listener.handle(
      chatEvent({
        id: 'm_0000000541',
        channelId: CHANNEL,
        taskId: TASK,
        senderType: 'agent',
        senderInstanceId: MEMBER,
        content: {
          parts: [{ type: 'text', text: 'verdict: reject @ v0.3，边界缺失' }],
        },
        status: 'sent',
      }),
    );
    expect(gate.recordVerdict).toHaveBeenCalledWith(
      HOST_ISSUE,
      {
        member: MEMBER,
        verdict: 'REJECT',
        msgId: 'm_0000000541',
        version: 'v0.3',
      },
      expect.objectContaining({ channelId: CHANNEL }),
    );
  });

  it('缺版本 → 照样转发且不带 version（门层打回，不静默丢）', async () => {
    const { gate, listener } = setup();
    await listener.handle(
      chatEvent(agentMessage('VERDICT: APPROVE\n依据充分')),
    );
    expect(gate.recordVerdict).toHaveBeenCalledTimes(1);
    const input = (gate.recordVerdict as jest.Mock).mock
      .calls[0]?.[1] as Record<string, unknown>;
    expect(input).toEqual({
      member: MEMBER,
      verdict: 'APPROVE',
      msgId: 'm_0000000540',
    });
    expect('version' in input).toBe(false);
  });

  it('无 VERDICT 的 agent 消息 → 门层不调用（且不查库）', async () => {
    const { gate, prisma, listener } = setup();
    await listener.handle(chatEvent(agentMessage('今天进度正常，无阻塞')));
    expect(gate.recordVerdict).not.toHaveBeenCalled();
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
  });

  it('user 消息 → 门层不调用', async () => {
    const { gate, listener } = setup();
    await listener.handle(
      chatEvent({
        ...agentMessage('VERDICT: APPROVE @ v0.3'),
        senderType: 'user',
        senderInstanceId: null,
      }),
    );
    expect(gate.recordVerdict).not.toHaveBeenCalled();
  });

  it('任务无账本宿主 → 门层不调用（不建账）', async () => {
    const { gate, prisma, listener } = setup({ withLedger: false });
    await listener.handle(chatEvent(agentMessage('VERDICT: APPROVE @ v0.3')));
    expect(gate.recordVerdict).not.toHaveBeenCalled();
    expect(prisma.issue.findMany).toHaveBeenCalled();
  });

  it('门层抛错 → listener 吞掉 + warn，不向 bus 抛错', async () => {
    const { gate, listener } = setup();
    gate.recordVerdict.mockRejectedValueOnce(new Error('db down'));
    await expect(
      listener.handle(chatEvent(agentMessage('VERDICT: APPROVE @ v0.3'))),
    ).resolves.toBeUndefined();
    expect(gate.recordVerdict).toHaveBeenCalledTimes(1);
  });

  it('同一消息投递两次 → 两次转发入参完全一致（门层按 msgId 幂等）', async () => {
    const { gate, listener } = setup();
    const event = chatEvent(agentMessage('VERDICT: APPROVE @ v0.3'));
    await listener.handle(event);
    await listener.handle(event);
    expect(gate.recordVerdict).toHaveBeenCalledTimes(2);
    const calls = (gate.recordVerdict as jest.Mock).mock.calls;
    expect(calls[0]).toEqual(calls[1]);
  });

  it('门层未装配（Optional 缺省）→ warn + no-op，不崩', async () => {
    const realtime: any = { subscribe: jest.fn(() => () => undefined) };
    const prisma: any = { issue: { findMany: jest.fn() } };
    const listener = new ReviewVerdictListener(realtime, prisma, null);
    await expect(
      listener.handle(chatEvent(agentMessage('VERDICT: APPROVE @ v0.3'))),
    ).resolves.toBeUndefined();
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
  });

  it('通知接线缺口（无计划员/PM）→ 仍转发尽力而为 opts + warn', async () => {
    const { gate, prisma, listener } = setup();
    prisma.teamMember.findFirst.mockResolvedValueOnce(null);
    prisma.team.findUnique.mockResolvedValueOnce({ mainAgentMemberId: null });
    await listener.handle(chatEvent(agentMessage('VERDICT: APPROVE @ v0.3')));
    expect(gate.recordVerdict).toHaveBeenCalledTimes(1);
    expect(gate.recordVerdict).toHaveBeenCalledWith(
      HOST_ISSUE,
      expect.objectContaining({ verdict: 'APPROVE' }),
      expect.objectContaining({ channelId: CHANNEL, taskId: TASK }),
    );
  });

  it('F2#4：通知接线读取失败 → warn 带根因 + 仍尽力而为转发（账本写优先）', async () => {
    const { gate, prisma, listener } = setup();
    prisma.task.findUnique.mockRejectedValueOnce(new Error('db 瞬断'));
    prisma.teamMember.findFirst.mockRejectedValueOnce(new Error('db 瞬断'));
    const warn = jest
      .spyOn(
        (listener as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((() => undefined) as unknown as jest.Mock);
    await listener.handle(chatEvent(agentMessage('VERDICT: APPROVE @ v0.3')));
    expect(gate.recordVerdict).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db 瞬断'));
    warn.mockRestore();
  });

  it('onModuleInit 订阅 bus，onModuleDestroy 取消订阅', () => {
    const { realtime, listener } = setup();
    const off = jest.fn();
    realtime.subscribe.mockReturnValueOnce(off);
    listener.onModuleInit();
    expect(realtime.subscribe).toHaveBeenCalledTimes(1);
    listener.onModuleDestroy();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('live 回归：team-group verdict（payload 无 taskId、频道 task_id 为 NULL，靠 messages.task_id 回查）→ 门层被调用', async () => {
    const { gate, prisma, listener } = setup();
    const liveTask = 't_0000000003';
    const teamGroup = 'c_0000000007';
    prisma.message.findUnique.mockResolvedValueOnce({ taskId: liveTask });
    prisma.chatChannel.findUnique.mockResolvedValueOnce({
      taskId: null,
      teamId: TEAM,
    });
    const event = {
      id: 'ev_0000008841',
      type: EVENT_TYPES.CHAT_MESSAGE_NEW,
      payload: {
        message: {
          id: 'm_0000001209',
          status: 'sent',
          content: {
            text: 'VERDICT: APPROVE @ v0.3\n依据：设计一致',
            parts: [],
          },
          mentions: [],
          senderId: 'a_architect',
          channelId: teamGroup,
          createdAt: new Date().toISOString(),
          senderType: 'agent',
          attachmentUrl: null,
          attachmentName: null,
          attachmentType: null,
          senderInstanceId: MEMBER,
        },
      },
      timestamp: new Date().toISOString(),
      scopeType: 'channel',
      scopeId: teamGroup,
    } as RealtimeEvent;
    await listener.handle(event);
    expect(prisma.message.findUnique).toHaveBeenCalledWith({
      where: { id: 'm_0000001209' },
      select: { taskId: true },
    });
    expect(gate.recordVerdict).toHaveBeenCalledTimes(1);
    expect(gate.recordVerdict).toHaveBeenCalledWith(
      HOST_ISSUE,
      {
        member: MEMBER,
        verdict: 'APPROVE',
        msgId: 'm_0000001209',
        version: 'v0.3',
      },
      expect.objectContaining({ channelId: teamGroup, taskId: liveTask }),
    );
  });

  it('消息行 task_id 为空 → 回退团队 currentTaskId → 门层被调用', async () => {
    const { gate, prisma, listener } = setup();
    const activeTask = 't_0000000009';
    const teamGroup = 'c_0000000007';
    prisma.message.findUnique.mockResolvedValueOnce({ taskId: null });
    prisma.chatChannel.findUnique.mockResolvedValueOnce({
      taskId: null,
      teamId: TEAM,
    });
    prisma.team.findUnique.mockImplementation(
      async (args: { where: { id: string } }) =>
        args.where.id === TEAM
          ? { mainAgentMemberId: PM, currentTaskId: activeTask }
          : null,
    );
    const event = {
      ...(chatEvent({
        id: 'm_0000001210',
        channelId: teamGroup,
        senderType: 'agent',
        senderId: 'a_architect',
        senderInstanceId: MEMBER,
        content: { text: 'VERDICT: REJECT @ v0.3\n依据：边界缺失', parts: [] },
        status: 'sent',
      }) as unknown as Record<string, unknown>),
      scopeId: teamGroup,
    } as unknown as RealtimeEvent;
    await listener.handle(event);
    expect(gate.recordVerdict).toHaveBeenCalledTimes(1);
    expect(gate.recordVerdict).toHaveBeenCalledWith(
      HOST_ISSUE,
      expect.objectContaining({ verdict: 'REJECT', msgId: 'm_0000001210' }),
      expect.objectContaining({ channelId: teamGroup, taskId: activeTask }),
    );
  });

  it('所有来源都无任务（消息行空 + 无团队 + 频道 task_id 空）→ 门层不调用', async () => {
    const { gate, prisma, listener } = setup();
    prisma.message.findUnique.mockResolvedValueOnce({ taskId: null });
    prisma.chatChannel.findUnique.mockResolvedValueOnce({
      taskId: null,
      teamId: null,
    });
    const event = {
      ...(chatEvent({
        id: 'm_0000001211',
        channelId: 'c_0000000007',
        senderType: 'agent',
        senderId: 'a_architect',
        senderInstanceId: MEMBER,
        content: { text: 'VERDICT: APPROVE @ v0.3', parts: [] },
        status: 'sent',
      }) as unknown as Record<string, unknown>),
      scopeId: 'c_0000000007',
    } as unknown as RealtimeEvent;
    await listener.handle(event);
    expect(gate.recordVerdict).not.toHaveBeenCalled();
  });
});
