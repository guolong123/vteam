import {
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import {
  hashText,
  MockDispatcher,
  MOCK_DELAY_MS,
  MOCK_DELAY_RANGE_MS,
} from './mock-dispatcher';

describe('MockDispatcher', () => {
  let prisma: { message: { create: jest.Mock } };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };

  const request = {
    messageId: 'm_0000000001',
    channelId: 'c_0000000001',
    taskId: 't_0000000001',
    text: '你好，请处理',
    targets: [{ agentId: 'a_product', sessionId: 's_0000000001' }],
  };

  const messageRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'm_0000000002',
    channelId: request.channelId,
    senderType: SENDER_TYPE.agent,
    senderId: 'a_product',
    content: { text: 'x', parts: [] },
    mentions: null,
    status: MESSAGE_STATUS.sent,
    createdAt: new Date('2026-08-07T00:00:00Z'),
    ...overrides,
  });

  /** 直接实例化（不走 Nest DI）：延迟字段实例化后覆盖（默认 0 = 立即跑完整异步链，便于断言时序/确定性）。 */
  const createDispatcher = (delayMs = 0, delayRangeMs = 0) => {
    const d = new MockDispatcher(prisma as any, idGen as any, realtime as any);
    d.delayMs = delayMs;
    d.delayRangeMs = delayRangeMs;
    return d;
  };

  beforeEach(() => {
    prisma = { message: { create: jest.fn() } };
    idGen = { nextId: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
  });

  describe('确定性模板回复（同输入同输出）', () => {
    it('同一触发两次回复相同（可断言）', async () => {
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');
      const d1 = createDispatcher();
      const d2 = createDispatcher();

      const [r1, r2] = await Promise.all([d1.dispatch(request), d2.dispatch(request)]);

      expect(r1.replies).toEqual(r2.replies);
      expect(r1.replies[0].text).toBe(r2.replies[0].text);
    });

    it('按 Agent 角色选模板：a_architect → 架构师文案、a_tester → 测试文案', async () => {
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');
      const d = createDispatcher();

      const architect = await d.dispatch({
        ...request,
        targets: [{ agentId: 'a_architect', sessionId: 's_1' }],
      });
      const tester = await d.dispatch({
        ...request,
        targets: [{ agentId: 'a_tester', sessionId: 's_1' }],
      });

      expect(architect.replies[0].text).toMatch(/技术方案|设计文档|评审结论/);
      expect(tester.replies[0].text).toMatch(/测试用例|验证结论/);
    });

    it('未知角色 → 兜底默认模板', async () => {
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');
      const d = createDispatcher();

      const result = await d.dispatch({
        ...request,
        targets: [{ agentId: 'a_custom_role', sessionId: null }],
      });

      expect(result.replies[0].text).toMatch(/已收到你的消息|已记录需求要点/);
    });

    it('hashText 确定性：同输入同值，不同输入可区分', () => {
      expect(hashText('你好')).toBe(hashText('你好'));
      expect(hashText('hello')).toBe(hashText('hello'));
      expect(hashText('你好')).not.toBe(hashText('hello'));
    });
  });

  describe('延迟（默认 1~3s，可配置注入）', () => {
    it('fake timers：延迟未到不产生任何事件，到点后 loading→落库→广播完成', async () => {
      jest.useFakeTimers();
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
      // 1000 + 0.5 * 2000 = 2000ms
      const d = createDispatcher(MOCK_DELAY_MS, MOCK_DELAY_RANGE_MS);
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');

      const promise = d.dispatch(request);
      // 延迟未到：无 loading/落库/广播
      await jest.advanceTimersByTimeAsync(1999);
      expect(realtime.broadcast).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();

      // 到点（2000ms）：时序全部完成
      await jest.advanceTimersByTimeAsync(1);
      await promise;
      expect(realtime.broadcast).toHaveBeenCalledTimes(3);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);

      randomSpy.mockRestore();
      jest.useRealTimers();
    });

    it('延迟在 1~3s 区间内：推进到 1s 未完成、3s 必然完成（random 取极值）', async () => {
      jest.useFakeTimers();
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.999);
      // 1000 + 0.999 * 2000 ≈ 2998ms < 3s
      const d = createDispatcher(MOCK_DELAY_MS, MOCK_DELAY_RANGE_MS);
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');

      const promise = d.dispatch(request);
      await jest.advanceTimersByTimeAsync(999);
      expect(realtime.broadcast).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(2998 - 999);
      await promise;
      expect(realtime.broadcast).toHaveBeenCalledTimes(3);

      randomSpy.mockRestore();
      jest.useRealTimers();
    });
  });

  describe('loading → final 时序', () => {
    it('单目标：loading(thinking) → loading(operating) → 落库(agent) → 广播 chat.message.new(channel)', async () => {
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');
      const d = createDispatcher();

      const result = await d.dispatch(request);

      // 广播顺序：2×agent.loading + 1×chat.message.new
      expect(realtime.broadcast.mock.calls.map((c) => c[0])).toEqual([
        EVENT_TYPES.AGENT_LOADING,
        EVENT_TYPES.AGENT_LOADING,
        EVENT_TYPES.CHAT_MESSAGE_NEW,
      ]);
      // Loading 两阶段（scope=task）：thinking → operating
      expect(realtime.broadcast).toHaveBeenNthCalledWith(
        1,
        EVENT_TYPES.AGENT_LOADING,
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 's_0000000001',
          phase: 'thinking',
        },
        { type: 'task', id: request.taskId },
      );
      expect(realtime.broadcast).toHaveBeenNthCalledWith(
        2,
        EVENT_TYPES.AGENT_LOADING,
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 's_0000000001',
          phase: 'operating',
        },
        { type: 'task', id: request.taskId },
      );
      // 落库：senderType=agent，senderId=agentId，内容=确定性模板
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'm_0000000002',
          channelId: request.channelId,
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          content: { text: result.replies[0].text, parts: [] },
          mentions: null,
          status: MESSAGE_STATUS.sent,
        }),
      });
      // 广播 final：chat.message.new（channel scope）
      expect(realtime.broadcast).toHaveBeenNthCalledWith(
        3,
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            id: 'm_0000000002',
            senderType: 'agent',
            senderId: 'a_product',
          }),
        },
        { type: 'channel', id: request.channelId },
      );
    });

    it('回调契约：onLoading ×2（thinking→operating）→ onFinal ×1（落库+广播后），事件内容对号', async () => {
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');
      const d = createDispatcher();
      const loading: unknown[] = [];
      const finals: unknown[] = [];
      d.onLoading((e) => loading.push(e)).onFinal((e) => finals.push(e));

      const result = await d.dispatch(request);

      expect(loading).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 's_0000000001',
          phase: 'thinking',
        },
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 's_0000000001',
          phase: 'operating',
        },
      ]);
      expect(finals).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          messageId: 'm_0000000002',
          text: result.replies[0].text,
        },
      ]);
    });

    it('回调契约：单目标失败 → onError 触发（其他目标不阻塞）', async () => {
      prisma.message.create.mockRejectedValue(new Error('db down'));
      idGen.nextId.mockResolvedValue('m_0000000002');
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      const result = await d.dispatch({
        ...request,
        targets: [
          { agentId: 'a_product', sessionId: 's_1' },
          { agentId: 'a_developer', sessionId: 's_2' },
        ],
      });

      expect(errors).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          error: 'db down',
        },
        {
          taskId: request.taskId,
          agentId: 'a_developer',
          error: 'db down',
        },
      ]);
      expect(result.replies).toEqual([]);
    });

    it('回调异常被吞：onFinal 抛错不影响分派结果与广播', async () => {
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');
      const d = createDispatcher();
      d.onFinal(() => {
        throw new Error('subscriber bug');
      });

      const result = await d.dispatch(request);

      expect(result.replies).toHaveLength(1);
      expect(realtime.broadcast).toHaveBeenCalledTimes(3);
    });

    it('多目标：逐目标串行（每目标 2 loading + 1 final），phase 与 agentId 一一对应', async () => {
      prisma.message.create.mockResolvedValue(messageRow());
      idGen.nextId.mockResolvedValue('m_0000000002');
      const d = createDispatcher();

      await d.dispatch({
        ...request,
        targets: [
          { agentId: 'a_product', sessionId: 's_1' },
          { agentId: 'a_developer', sessionId: 's_2' },
        ],
      });

      expect(realtime.broadcast).toHaveBeenCalledTimes(6);
      // 每目标先 thinking 后 operating（串行不交错）
      expect(
        realtime.broadcast.mock.calls
          .filter((c) => c[0] === EVENT_TYPES.AGENT_LOADING)
          .map((c) => [c[1].agentId, c[1].phase]),
      ).toEqual([
        ['a_product', 'thinking'],
        ['a_product', 'operating'],
        ['a_developer', 'thinking'],
        ['a_developer', 'operating'],
      ]);
      // 每目标各自落库一次（senderId 对号）
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      expect(prisma.message.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ senderId: 'a_product' }),
        }),
      );
      expect(prisma.message.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ senderId: 'a_developer' }),
        }),
      );
    });
  });
});
