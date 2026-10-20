import { Test, TestingModule } from '@nestjs/testing';
import {
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TriggerService } from '../timers/trigger.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerClient } from '../workers/worker.client';
import {
  PlatformMcpService,
  WAKE_TEXT_BODY_MAX_CHARS,
  formatWakeBody,
} from './platform-mcp.service';
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
import { SkillsService } from '../skills/skills.service';
import { GitReposService } from '../git-repos/git-repos.service';
import { PlanLifecycleService } from '../tasks/plan-lifecycle.service';
import { MessageReceiptsService } from '../chat/message-receipts.service';

/**
 * 缺陷 3：子 Agent 完工回执被截断 —— 回执正文恰在 200 字符处被硬切，
 * 原文在群聊完整，但**接收方无从找到原文**。
 *
 * 修复：截断预算（200 字符）保留（平台铁律「只发增量」，回执原文留群聊），
 * 但截断时附**原始 messageId + 详见群聊**，接收方据此定位全文。
 * 本 spec 断言的是**可观察属性**：接收方拿到的唤醒正文里带 messageId，
 * 且该 messageId 对应的群聊消息行持有完整回执。
 */
describe('PlatformMcpService 完工回执截断（缺陷 3）', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { create: jest.Mock; findMany: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    teamMember: { findFirst: jest.Mock; findUnique: jest.Mock };
    issue: { findUnique: jest.Mock };
    messageReceipt: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
  };
  let idGen: { nextId: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
    isSessionPending: jest.Mock;
  };
  let receipts: MessageReceiptsService;

  const taskId = 't_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId: 'w_0000000001' };
  const mainInstanceId = 'tmm_main';
  const sub1 = 'tmm_sub1';
  const teamId = 'tm_0000000001';
  const messageId = 'm_0000000200';

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { create: jest.fn(), findMany: jest.fn() },
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: { findFirst: jest.fn(), findUnique: jest.fn() },
      issue: { findUnique: jest.fn() },
      messageReceipt: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    };
    idGen = { nextId: jest.fn() };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
      isSessionPending: jest.fn().mockReturnValue(false),
    };
    const receiptsSvc = {
      ackPendingFor: jest.fn().mockResolvedValue(1),
      countPendingFor: jest.fn().mockResolvedValue(0),
      registerSettledHook: jest.fn(),
    };
    const planLifecycle = { getStatus: jest.fn(), autoEnsureRow: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
        { provide: WorkerClient, useValue: { fetchFile: jest.fn() } },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ArtifactsService, useValue: {} },
        { provide: IssuesService, useValue: {} },
        { provide: TasksService, useValue: {} },
        { provide: QuestionsService, useValue: {} },
        {
          provide: NotificationDispatcherService,
          useValue: { sendToChannelByIdOrName: jest.fn() },
        },
        { provide: ExecutionPolicyService, useValue: {} },
        { provide: SkillsService, useValue: {} },
        { provide: GitReposService, useValue: { findAll: jest.fn() } },
        { provide: PlanLifecycleService, useValue: planLifecycle },
        { provide: TriggerService, useValue: { schedule: jest.fn() } },
        { provide: MessageReceiptsService, useValue: receiptsSvc },
      ],
    }).compile();

    service = module.get(PlatformMcpService);
    receipts = module.get(MessageReceiptsService);

    prisma.task.findUnique.mockImplementation(
      (args: { where: { id?: string } }) =>
        args.where.id === taskId
          ? Promise.resolve({ teamId })
          : Promise.resolve(null),
    );
    prisma.session.findFirst.mockImplementation(
      (args: { where?: { teamMemberId?: string } }) => {
        const memberId = args?.where?.teamMemberId ?? sub1;
        const isMain = memberId === mainInstanceId;
        return Promise.resolve({
          id: isMain ? 's_main' : 's_sub',
          status: 'idle',
          workerId: 'w_0000000001',
          teamMemberId: memberId,
          agentId: isMain ? 'a_main' : 'a_sub',
        });
      },
    );
    prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
    prisma.teamMember.findFirst.mockImplementation(
      (args: { where: { id?: string } }) =>
        args.where.id === mainInstanceId
          ? Promise.resolve({
              agentId: 'a_main',
              alias: '主',
              agent: { id: 'a_main', name: '主' },
            })
          : Promise.resolve({
              agentId: 'a_sub',
              alias: '子',
              agent: { id: 'a_sub', name: '子' },
            }),
    );
    prisma.teamMember.findUnique.mockImplementation(
      (args: { where: { id?: string } }) =>
        Promise.resolve({
          agentId: args?.where?.id === mainInstanceId ? 'a_main' : 'a_sub',
        }),
    );
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: mainInstanceId,
    });
    idGen.nextId.mockImplementation(async (prefix: string) =>
      prefix === 'mr' ? 'mr_0000000001' : messageId,
    );
    prisma.message.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...data,
          id: messageId,
          channelId,
          status: MESSAGE_STATUS.sent,
          senderType: SENDER_TYPE.agent,
          createdAt: new Date(),
        }),
    );
    prisma.message.findMany.mockResolvedValue([]);
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
    prisma.messageReceipt.findMany.mockResolvedValue([]);
    prisma.messageReceipt.count.mockResolvedValue(0);
    planLifecycle.getStatus.mockResolvedValue('executing');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('回执正文超预算 → 截断但附原始 messageId + 详见群聊（接收方可定位全文）', () => {
    const long = 'A'.repeat(500);
    const body = formatWakeBody(long, messageId);
    expect(body).toContain('详见群聊');
    expect(body).toContain(messageId);
    expect(body.length).toBeLessThan(long.length);
    expect(body).toContain('已截断');
    expect(body).not.toContain('A'.repeat(WAKE_TEXT_BODY_MAX_CHARS + 1));
  });

  it('未超预算 → 正文完整，仍带 messageId 指针', () => {
    const short = '短回执';
    const body = formatWakeBody(short, messageId);
    expect(body).toContain(short);
    expect(body).toContain(messageId);
    expect(body).not.toContain('已截断');
  });

  it('端到端：完工回执落库（全文）→ 唤醒正文带 messageId，可据此取回全文', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(0);
    const longContent = `完工摘要：${'细节'.repeat(300)}`;

    const result = await service.notifyAgent(ctx, {
      taskId,
      targetInstanceId: mainInstanceId,
      content: longContent,
      selfInstanceId: sub1,
      type: 'answer',
      stage: 'end',
    });

    // ① 回执原文完整落在群聊消息行（接收方据此取全文）
    expect(result.messageId).toBe(messageId);
    const created = prisma.message.create.mock.calls[0][0].data as {
      content: { text: string };
    };
    expect(created.content.text).toContain(longContent);

    // ② 唤醒正文带 messageId + 详见群聊 → 接收方能定位原文
    await jest.runOnlyPendingTimersAsync();
    const wakeCalls = workerDispatcher.dispatchAgentMention.mock.calls.filter(
      (c: [{ kind: string }]) => c[0].kind === 'wake',
    );
    expect(wakeCalls.length).toBe(1);
    const wakeText = wakeCalls[0][0].text as string;
    expect(wakeText).toContain(messageId);
    expect(wakeText).toContain('详见群聊');
    expect(wakeText).toContain('已截断');
    // ③ 唤醒正文本身仍是「增量」（未把全文灌进 prompt）
    expect(wakeText.length).toBeLessThan(longContent.length);
  });
});
