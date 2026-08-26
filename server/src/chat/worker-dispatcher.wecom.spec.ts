import { WorkerDispatcher } from './worker-dispatcher';
import { CHANNEL_TYPE, SENDER_TYPE } from '../common/constants/event.constants';
import { WecomAibotAdapter } from '../message-channels/adapters/wecom-aibot.adapter';

describe('WorkerDispatcher wecom bridge (diagnostic)', () => {
  let prisma: any;
  let idGen: any;
  let realtime: any;
  let workersService: any;
  let workerClient: any;
  let sessionLifecycle: any;
  let artifactsService: any;
  let config: any;
  let ingress: any;
  let wecomAdapter: any;
  let messageRegistry: any;
  let moduleRef: any;

  const taskId = 't_wecom_1';
  const externalMsgId = 'm_external_1';
  const groupChannelId = 'c_group_1';
  const wecomChannelId = 'mc_wecom_1';

  function createDispatcher() {
    return new WorkerDispatcher(
      prisma as any,
      idGen as any,
      realtime as any,
      workersService as any,
      workerClient as any,
      sessionLifecycle as any,
      artifactsService as any,
      config as any,
      ingress as any,
      moduleRef as any,
    );
  }

  beforeEach(() => {
    prisma = {
      session: {
        findUnique: jest.fn().mockResolvedValue({ agentId: 'a_dev', taskAgentId: 'ta_1' }),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      message: {
        create: jest.fn().mockImplementation((q: any) =>
          Promise.resolve({
            id: q?.data?.id ?? 'm_new',
            channelId: q?.data?.channelId ?? groupChannelId,
            senderType: q?.data?.senderType ?? SENDER_TYPE.agent,
            senderId: q?.data?.senderId ?? 'a_dev',
            content: q?.data?.content ?? { text: 'hi' },
            mentions: null,
            status: q?.data?.status ?? 'sent',
            createdAt: new Date(),
          }),
        ),
        findFirst: jest.fn().mockImplementation((q: any) => {
          if (q?.where?.channelId === groupChannelId && q?.where?.senderType === SENDER_TYPE.external) {
            return Promise.resolve({ id: externalMsgId, content: { text: 'hi' } });
          }
          if (q?.where?.channelId && q?.where?.senderType === SENDER_TYPE.agent && q?.where?.status === 'processing') {
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation((q: any) =>
          Promise.resolve({
            id: q?.where?.id ?? 'm_upd',
            channelId: groupChannelId,
            senderType: SENDER_TYPE.agent,
            senderId: 'a_dev',
            content: q?.data?.content ?? { text: 'upd' },
            mentions: null,
            status: q?.data?.status ?? 'sent',
            createdAt: new Date(),
          }),
        ),
        updateMany: jest.fn(),
      },
      chatChannel: {
        findUnique: jest.fn().mockResolvedValue({ id: groupChannelId, type: CHANNEL_TYPE.task_group }),
        findFirst: jest.fn().mockImplementation((q: any) => {
          if (q?.where?.taskId === taskId && q?.where?.type === CHANNEL_TYPE.task_group) {
            return Promise.resolve({ id: groupChannelId });
          }
          if (q?.where?.id === groupChannelId) return Promise.resolve({ id: groupChannelId, type: CHANNEL_TYPE.task_group });
          return Promise.resolve({ id: groupChannelId, type: CHANNEL_TYPE.private });
        }),
      },
      task: { findUnique: jest.fn().mockResolvedValue(null) },
      taskAgent: { findUnique: jest.fn().mockResolvedValue(null) },
      artifact: { findMany: jest.fn().mockResolvedValue([]) },
      artifactVersion: { findMany: jest.fn().mockResolvedValue([]) },
      worker: { findUnique: jest.fn().mockResolvedValue(null) },
      agent: { findUnique: jest.fn().mockResolvedValue({ id: 'a_dev', name: 'dev' }) },
      messageChannel: {
        findUnique: jest.fn().mockImplementation((q: any) => {
          if (q?.where?.id === wecomChannelId) return Promise.resolve({ id: wecomChannelId, type: 'wecom_aibot', config: {} });
          return Promise.resolve(null);
        }),
      },
      taskMessageChannel: {
        findMany: jest.fn().mockResolvedValue([{ messageChannelId: wecomChannelId }]),
      },
      chatMessage: { findFirst: jest.fn() },
    };
    idGen = { nextId: jest.fn().mockResolvedValue('m_new_1') };
    realtime = { broadcast: jest.fn().mockResolvedValue({}) };
    workersService = { assignWorker: jest.fn() };
    workerClient = { createSession: jest.fn(), promptAsync: jest.fn(), getMessages: jest.fn().mockResolvedValue([]), execute: jest.fn().mockResolvedValue(undefined) };
    sessionLifecycle = { bindSessionToWorker: jest.fn(), unbindSession: jest.fn().mockResolvedValue({}) };
    artifactsService = { onArtifactSubmitted: jest.fn().mockResolvedValue({ status: 'archived' }) };
    config = { get: jest.fn(() => undefined) };
    ingress = { onTaskCompleted: jest.fn(), onAgentStatus: jest.fn(), onSessionActivity: jest.fn() };
    wecomAdapter = {
      finishStream: jest.fn().mockResolvedValue(true),
      sendFallbackMessage: jest.fn().mockResolvedValue(true),
      registerStreamCorrelation: jest.fn(),
      getStream: jest.fn(),
      type: 'wecom_aibot',
    };
    messageRegistry = {
      get: jest.fn().mockImplementation((type: string) => {
        if (type === 'wecom_aibot') return wecomAdapter;
        return undefined;
      }),
    };
    moduleRef = {
      get: jest.fn().mockImplementation((token: unknown) => {
        if (token === WecomAibotAdapter) return wecomAdapter;
        return undefined;
      }),
    };
  });

  it('finishStream called with externalMsg.id when text present', async () => {
    const d = createDispatcher();
    await d.handleTaskCompleted({ taskId, sessionId: 's_1', agentId: 'a_dev', text: 'hello reply', parts: [] });
    expect(wecomAdapter.finishStream).toHaveBeenCalledWith(externalMsgId, 'hello reply');
  });

  it('text derived from parts when payload.text empty', async () => {
    const d = createDispatcher();
    await d.handleTaskCompleted({
      taskId,
      sessionId: 's_1',
      agentId: 'a_dev',
      text: '',
      parts: [{ type: 'text', text: 'parts reply' }] as any,
    });
    expect(wecomAdapter.finishStream).toHaveBeenCalledWith(externalMsgId, 'parts reply');
  });

  it('fallback called when finishStream miss', async () => {
    wecomAdapter.finishStream.mockResolvedValue(false);
    const d = createDispatcher();
    await d.handleTaskCompleted({ taskId, sessionId: 's_1', agentId: 'a_dev', text: 'hi', parts: [] });
    expect(wecomAdapter.sendFallbackMessage).toHaveBeenCalledWith(wecomChannelId, 'hi');
  });

  it('logs no wecom adapter when both missing', async () => {
    wecomAdapter = undefined;
    messageRegistry.get.mockReturnValue(undefined);
    moduleRef.get.mockReturnValue(undefined);
    const d = createDispatcher();
    const warnSpy = jest.spyOn((d as any).logger, 'warn').mockImplementation(() => {});
    await d.handleTaskCompleted({ taskId, sessionId: 's_1', agentId: 'a_dev', text: 'hi', parts: [] });
    const calls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('no wecom adapter'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('logs externalMsg miss when no external message', async () => {
    prisma.message.findFirst.mockResolvedValue(null);
    const d = createDispatcher();
    const warnSpy = jest.spyOn((d as any).logger, 'warn').mockImplementation(() => {});
    await d.handleTaskCompleted({ taskId, sessionId: 's_1', agentId: 'a_dev', text: 'hi', parts: [] });
    const calls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('externalMsg not found'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('logs bindings and wecom channels count', async () => {
    const d = createDispatcher();
    const logSpy = jest.spyOn((d as any).logger, 'log').mockImplementation(() => {});
    await d.handleTaskCompleted({ taskId, sessionId: 's_1', agentId: 'a_dev', text: 'hi', parts: [] });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('wecom bridge: taskId='))).toBe(true);
    expect(calls.some((m) => m.includes('bindings=') && m.includes('found wecom channels='))).toBe(true);
    logSpy.mockRestore();
  });

  it('post-card reply after question uses sendNewMessage as new message after card not finishStream', async () => {
    wecomAdapter.getPendingOperatorForTask = jest.fn().mockReturnValue({ fromUserId: 'GuoLong', fromUserName: 'GuoLong', chattype: 'group', channelId: wecomChannelId });
    wecomAdapter.consumePendingOperatorForTask = jest.fn().mockReturnValue({ fromUserId: 'GuoLong', fromUserName: 'GuoLong' });
    wecomAdapter.discardStream = jest.fn().mockReturnValue(true);
    wecomAdapter.sendNewMessage = jest.fn().mockResolvedValue(true);
    wecomAdapter.getStream = jest.fn().mockReturnValue(undefined);
    wecomAdapter.getPendingUser = jest.fn().mockReturnValue(undefined);
    const d = createDispatcher();
    await d.handleTaskCompleted({ taskId, sessionId: 's_1', agentId: 'a_dev', text: 'final after card', parts: [] });
    expect(wecomAdapter.discardStream).toHaveBeenCalledWith(externalMsgId);
    expect(wecomAdapter.sendNewMessage).toHaveBeenCalledWith(wecomChannelId, expect.stringContaining('final after card'));
    expect(wecomAdapter.finishStream).not.toHaveBeenCalled();
    expect(wecomAdapter.consumePendingOperatorForTask).toHaveBeenCalledWith(taskId);
    const expectedMirrorText = `@GuoLong final after card`;
    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: expect.objectContaining({ text: expectedMirrorText }) }),
    }));
  });

  it('simple non-question reply still uses finishStream to replace placeholder', async () => {
    wecomAdapter.getPendingOperatorForTask = jest.fn().mockReturnValue(undefined);
    wecomAdapter.getStream = jest.fn().mockReturnValue({ fromUserId: 'alice', fromUserName: 'Alice', chattype: 'group' });
    wecomAdapter.discardStream = jest.fn();
    wecomAdapter.sendNewMessage = jest.fn();
    const d = createDispatcher();
    await d.handleTaskCompleted({ taskId, sessionId: 's_1', agentId: 'a_dev', text: 'simple reply', parts: [] });
    expect(wecomAdapter.finishStream).toHaveBeenCalledWith(externalMsgId, expect.stringContaining('simple reply'));
    expect(wecomAdapter.discardStream).not.toHaveBeenCalled();
    expect(wecomAdapter.sendNewMessage).not.toHaveBeenCalled();
  });

  it('post-card fallback to sendFallbackMessage when sendNewMessage missing', async () => {
    wecomAdapter.getPendingOperatorForTask = jest.fn().mockReturnValue({ fromUserId: 'Bob', fromUserName: 'Bob', chattype: 'single' });
    wecomAdapter.consumePendingOperatorForTask = jest.fn();
    wecomAdapter.discardStream = jest.fn().mockReturnValue(true);
    delete wecomAdapter.sendNewMessage;
    wecomAdapter.sendFallbackMessage = jest.fn().mockResolvedValue(true);
    wecomAdapter.getStream = jest.fn().mockReturnValue(undefined);
    const d = createDispatcher();
    await d.handleTaskCompleted({ taskId, sessionId: 's_1', agentId: 'a_dev', text: 'fallback after card', parts: [] });
    expect(wecomAdapter.sendFallbackMessage).toHaveBeenCalledWith(wecomChannelId, expect.stringContaining('fallback after card'));
    expect(wecomAdapter.finishStream).not.toHaveBeenCalled();
  });
});
