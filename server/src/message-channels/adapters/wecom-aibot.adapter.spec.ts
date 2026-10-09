/**
 * 适配器 `import { WSClient, generateReqId } from '@wecom/aibot-node-sdk'`，
 * start() 路径会真实 `new WSClient(...)` 并调用 `on()` / `connect()` / `disconnect()`。
 * 原 spec 对 start() 零覆盖，所以必须整体 mock 掉 SDK 才能驱动连接生命周期。
 */
const mockClients: any[] = [];
const mockConnectImpls: Array<() => void> = [];
jest.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: jest.fn().mockImplementation(() => {
    const c = {
      connect: jest.fn(() => {
        const impl = mockConnectImpls.shift();
        if (impl) impl();
      }),
      disconnect: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      replyStream: jest.fn().mockResolvedValue({}),
      updateTemplateCard: jest.fn().mockResolvedValue({}),
      sendMessage: jest.fn().mockResolvedValue({}),
      sendCard: jest.fn().mockResolvedValue({}),
    };
    mockClients.push(c);
    return c;
  }),
  generateReqId: jest.fn(() => 'req_test'),
}));

import { WecomAibotAdapter } from './wecom-aibot.adapter';

/**
 * 最小 MessageHost 替身。
 *
 * resolveChannelIds() 的取 channelId 顺序：
 *   1) candidates=[ctx, this.attachedHost]，逐个找 `prisma.integrationChannel.findMany`
 *      → 不存在，跳过；
 *   2) 同一候选上找 `prisma.messageChannel.findMany` → 命中，返回 rows.map(r => r.id)。
 * 因此这里只需提供 `prisma.messageChannel.findMany`，start() 每个 channel 再走
 * `ctx.getChannel(id)` 取 botId/secret、`ctx.updateChannelRuntime` 回写状态。
 */
function makeHost(channels: Array<{ id: string; secrets?: any }>) {
  return {
    prisma: {
      messageChannel: {
        findMany: jest
          .fn()
          .mockResolvedValue(channels.map((c) => ({ id: c.id }))),
      },
    },
    getChannel: jest.fn(async (id: string) => {
      const c = channels.find((x) => x.id === id);
      return c
        ? {
            id: c.id,
            type: 'wecom_aibot',
            config: {},
            secrets: c.secrets ?? { botId: 'b_' + id, secret: 's_' + id },
            enabled: true,
          }
        : null;
    }),
    updateChannelRuntime: jest.fn().mockResolvedValue(undefined),
    submitInbound: jest.fn(),
  } as any;
}

describe('WecomAibotAdapter (message-channels)', () => {
  let adapter: WecomAibotAdapter;

  beforeEach(() => {
    adapter = new WecomAibotAdapter();
    mockClients.length = 0;
    mockConnectImpls.length = 0;
  });

  it('type wecom_aibot and supportsInbound with sendQuestionCard', () => {
    expect(adapter.type).toBe('wecom_aibot');
    expect(adapter.supportsInbound).toBe(true);
    expect((adapter as any).sendOutbound).toBeUndefined();
    expect(typeof (adapter as any).sendQuestionCard).toBe('function');
  });

  it('normalizeInbound returns empty array (WS mode)', async () => {
    const cmds = await adapter.normalizeInbound(
      {},
      {
        id: 'mc_1',
        type: 'wecom_aibot',
        config: {},
        secrets: {},
        enabled: true,
      },
    );
    expect(cmds).toEqual([]);
  });

  it('registerStreamCorrelation LRU 100', () => {
    for (let i = 0; i < 101; i++) {
      adapter.registerStreamCorrelation(`msg_${i}`, {
        channelId: 'mc_1',
        frameHeaders: { req_id: `req_${i}` },
        streamId: `stream_${i}`,
      });
    }
    expect(adapter.getStreamSize()).toBe(100);
    expect(adapter.getStream('msg_0')).toBeUndefined();
    expect(adapter.getStream('msg_100')).toBeDefined();
  });

  it('attach stores host', () => {
    const host: any = { submitInbound: jest.fn() };
    adapter.attach(host);
    expect((adapter as any).attachedHost).toBe(host);
  });

  /**
   * spinner 泄漏回归（2026-09-30）：生产实测两条 06:35/06:43 的 stream 刷到 09:24
   * 仍未停止，企微回绝 `errcode=846608 stream message update expired (>10 minutes)`。
   * 根因是唯一清理路径 `size >= STREAM_LIMIT(100)` 的 FIFO 淘汰在低流量下永不触发。
   */
  describe('stream TTL 兜底回收', () => {
    const TTL = 10 * 60 * 1000;

    it('超龄 stream 被摘除且其 spinner timer 被 clearInterval', () => {
      const clearSpy = jest.spyOn(global, 'clearInterval');
      adapter.registerStreamCorrelation('m_old', {
        channelId: 'mc_1',
        frameHeaders: {},
        streamId: 'stream_old',
        spinnerTimer: setInterval(() => {}, 1000) as unknown as NodeJS.Timeout,
      });
      expect(adapter.getStream('m_old')).toBeDefined();

      // 把入表时刻推到 TTL 之前（超龄），再注册一条新 stream 触发清扫
      const entry = (adapter as any).streams.get('m_old');
      entry.registeredAt = Date.now() - TTL - 1000;
      adapter.registerStreamCorrelation('m_new', {
        channelId: 'mc_1',
        frameHeaders: {},
        streamId: 'stream_new',
      });

      expect(clearSpy).toHaveBeenCalled();
      expect(adapter.getStream('m_old')).toBeUndefined();
      expect(adapter.getStream('m_new')).toBeDefined();
      clearSpy.mockRestore();
    });

    it('未超龄的 stream 不被清扫（正常回流的 stream 保留）', () => {
      adapter.registerStreamCorrelation('m_fresh', {
        channelId: 'mc_1',
        frameHeaders: {},
        streamId: 'stream_fresh',
      });
      adapter.registerStreamCorrelation('m_another', {
        channelId: 'mc_1',
        frameHeaders: {},
        streamId: 'stream_another',
      });
      expect(adapter.getStream('m_fresh')).toBeDefined();
      expect(adapter.getStream('m_another')).toBeDefined();
    });

    it('清扫幂等：重复触发不抛错、不误删', () => {
      adapter.registerStreamCorrelation('m_1', {
        channelId: 'mc_1',
        frameHeaders: {},
        streamId: 'stream_1',
      });
      (adapter as any).reapExpiredStreams();
      (adapter as any).reapExpiredStreams();
      expect(adapter.getStream('m_1')).toBeDefined();
    });
  });

  it('finishStream logs called and miss when no stream', async () => {
    const ok = await adapter.finishStream('missing_id', 'hello');
    expect(ok).toBe(false);
    expect(adapter.getStream('missing_id')).toBeUndefined();
  });

  it('finishStream ok when stream and client present', async () => {
    const mockClient: any = {
      replyStream: jest.fn().mockResolvedValue(undefined),
    };
    (adapter as any).clients.set('mc_1', mockClient);
    adapter.registerStreamCorrelation('m_1', {
      channelId: 'mc_1',
      frameHeaders: { req_id: 'req_1' },
      streamId: 'stream_1',
    });
    const ok = await adapter.finishStream('m_1', 'reply text');
    expect(ok).toBe(true);
    expect(mockClient.replyStream).toHaveBeenCalled();
    expect(adapter.getStream('m_1')).toBeUndefined();
  });

  it('finishStream logs client miss when no client', async () => {
    adapter.registerStreamCorrelation('m_2', {
      channelId: 'mc_no_client',
      frameHeaders: { req_id: 'req_2' },
      streamId: 'stream_2',
    });
    const ok = await adapter.finishStream('m_2', 'text');
    expect(ok).toBe(false);
  });

  it('finishStream handles frameHeaders wrapped in headers', async () => {
    const mockClient: any = {
      replyStream: jest.fn().mockResolvedValue(undefined),
    };
    (adapter as any).clients.set('mc_2', mockClient);
    adapter.registerStreamCorrelation('m_3', {
      channelId: 'mc_2',
      frameHeaders: { headers: { req_id: 'req_3' } },
      streamId: 'stream_3',
    });
    const ok = await adapter.finishStream('m_3', 'hi');
    expect(ok).toBe(true);
  });

  it('registerStreamCorrelation stores wecom user info and chattype', () => {
    adapter.registerStreamCorrelation('m_wecom', {
      channelId: 'mc_1',
      frameHeaders: { req_id: 'r1' },
      streamId: 's1',
      fromUserId: 'GuoLong',
      fromUserName: 'GuoLong',
      chattype: 'group',
    });
    const ref = adapter.getStream('m_wecom');
    expect(ref?.fromUserId).toBe('GuoLong');
    expect(ref?.fromUserName).toBe('GuoLong');
    expect(ref?.chattype).toBe('group');
    expect(adapter.getPendingUser('m_wecom')).toEqual({
      fromUserId: 'GuoLong',
      fromUserName: 'GuoLong',
      chattype: 'group',
    });
  });

  it('single chattype stored and retrieved', () => {
    adapter.registerStreamCorrelation('m_single', {
      channelId: 'mc_1',
      frameHeaders: { req_id: 'r2' },
      streamId: 's2',
      fromUserId: 'alice',
      fromUserName: 'Alice',
      chattype: 'single',
    });
    expect(adapter.getStream('m_single')?.chattype).toBe('single');
    expect(adapter.getPendingUser('m_single')?.fromUserName).toBe('Alice');
  });

  it('sendQuestionCard permission builds button_interaction with approve/reject', async () => {
    const mockClient: any = {
      sendMessage: jest
        .fn()
        .mockResolvedValue({ errcode: 0, headers: { req_id: 'r1' } }),
    };
    (adapter as any).clients.set('mc_1', mockClient);
    const channel: any = {
      id: 'mc_1',
      type: 'wecom_aibot',
      config: { lastChatid: 'GuoLong' },
      secrets: {},
      enabled: true,
    };
    await adapter.sendQuestionCard(channel, {
      id: 'aq_1',
      kind: 'permission',
      content: { title: '写入文件', pattern: 'Write' },
    });
    expect(mockClient.sendMessage).toHaveBeenCalledWith(
      'GuoLong',
      expect.objectContaining({ msgtype: 'template_card' }),
    );
    const body = mockClient.sendMessage.mock.calls[0][1];
    expect(body.template_card.button_list).toHaveLength(2);
    expect(body.template_card.button_list[0].key).toBe('aq_1:approve');
    expect(body.template_card.button_list[1].key).toBe('aq_1:reject');
  });

  it('sendQuestionCard question with options builds buttons', async () => {
    const mockClient: any = {
      sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }),
    };
    (adapter as any).clients.set('mc_1', mockClient);
    const channel: any = {
      id: 'mc_1',
      type: 'wecom_aibot',
      config: { lastChatid: 'chat1' },
      secrets: {},
      enabled: true,
    };
    await adapter.sendQuestionCard(channel, {
      id: 'aq_2',
      kind: 'question',
      content: { questions: [{ question: 'Pick?', options: ['A', 'B'] }] },
    });
    const body = mockClient.sendMessage.mock.calls[0][1];
    expect(body.template_card.card_type).toBe('button_interaction');
    expect(body.template_card.button_list).toHaveLength(2);
    expect(body.template_card.button_list[0].key).toBe('aq_2:A');
  });

  it('sendQuestionCard question with 3 options uses vote_interaction for full text', async () => {
    const mockClient: any = {
      sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }),
    };
    (adapter as any).clients.set('mc_1', mockClient);
    const channel: any = {
      id: 'mc_1',
      type: 'wecom_aibot',
      config: { lastChatid: 'chat1' },
      secrets: {},
      enabled: true,
    };
    await adapter.sendQuestionCard(channel, {
      id: 'aq_2',
      kind: 'question',
      content: {
        questions: [
          {
            question: 'Pick?',
            options: ['选项一内容较长', '选项二内容', '选项三'],
          },
        ],
      },
    });
    const body = mockClient.sendMessage.mock.calls[0][1];
    expect(body.template_card.card_type).toBe('vote_interaction');
    expect(body.template_card.checkbox.option_list).toHaveLength(3);
    expect(body.template_card.checkbox.option_list[0].text).toBe(
      '选项一内容较长',
    );
    expect(body.template_card.checkbox.option_list[0].id).toBe(
      'aq_2:选项一内容较长',
    );
    expect(body.template_card.submit_button.key).toBe('aq_2:submit');
    expect(body.template_card.task_id).toBe('aq_2');
  });

  it('sendQuestionCard fallback markdown when no options', async () => {
    const mockClient: any = {
      sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }),
    };
    (adapter as any).clients.set('mc_1', mockClient);
    const channel: any = {
      id: 'mc_1',
      type: 'wecom_aibot',
      config: { lastChatid: 'chat1' },
      secrets: {},
      enabled: true,
    };
    await adapter.sendQuestionCard(channel, {
      id: 'aq_3',
      kind: 'question',
      content: { questions: [{ question: 'Q?', options: [] }] },
    });
    expect(mockClient.sendMessage).toHaveBeenCalledWith(
      'chat1',
      expect.objectContaining({ msgtype: 'markdown' }),
    );
  });

  it('sendQuestionCard throws TASK_NOT_BOUND when no chatId', async () => {
    const channel: any = {
      id: 'mc_1',
      type: 'wecom_aibot',
      config: {},
      secrets: {},
      enabled: true,
    };
    await expect(
      adapter.sendQuestionCard(channel, {
        id: 'aq_4',
        kind: 'permission',
        content: {},
      }),
    ).rejects.toThrow('TASK_NOT_BOUND');
  });

  describe('handleTemplateCardEvent vote_interaction', () => {
    it('vote submit with selected_items triggers card_action with correct aqId/action', async () => {
      const submitInbound = jest
        .fn()
        .mockResolvedValue({ results: [{ ok: true }] });
      const ctx: any = { submitInbound, updateChannelRuntime: jest.fn() };
      const mockClient: any = {
        on: jest.fn((ev: string, fn: any) => {
          mockClient._handlers = mockClient._handlers ?? {};
          mockClient._handlers[ev] = fn;
        }),
        updateTemplateCard: jest.fn().mockResolvedValue({}),
        sendMessage: jest.fn(),
        replyStream: jest.fn(),
      };
      (adapter as any).clients.set('mc_vote', mockClient);
      (adapter as any).bindListeners('mc_vote', mockClient, ctx);
      const handler =
        mockClient._handlers['event'] ??
        mockClient._handlers['event.template_card_event'];
      expect(handler).toBeDefined();
      const aqId = 'aq_vote_1';
      const frame: any = {
        headers: { req_id: 'req_vote_1' },
        body: {
          chattype: 'single',
          from: { userid: 'alice' },
          event: {
            eventtype: 'template_card_event',
            task_id: aqId,
            card_type: 'vote_interaction',
            event_key: `${aqId}:submit`,
            selected_items: {
              selected_item: [
                {
                  question_key: aqId,
                  option_ids: { option_id: [`${aqId}:选项一内容较长`] },
                },
              ],
            },
          },
        },
      };
      await handler(frame);
      expect(submitInbound).toHaveBeenCalledWith('mc_vote', [
        expect.objectContaining({
          kind: 'card_action',
          aqId,
          action: '选项一内容较长',
        }),
      ]);
    });

    it('vote submit handles nested template_card_event wrapper', async () => {
      const submitInbound = jest
        .fn()
        .mockResolvedValue({ results: [{ ok: true }] });
      const ctx: any = { submitInbound, updateChannelRuntime: jest.fn() };
      const mockClient: any = {
        on: jest.fn((ev: string, fn: any) => {
          mockClient._handlers = mockClient._handlers ?? {};
          mockClient._handlers[ev] = fn;
        }),
        updateTemplateCard: jest.fn().mockResolvedValue({}),
      };
      (adapter as any).clients.set('mc_nested', mockClient);
      (adapter as any).bindListeners('mc_nested', mockClient, ctx);
      const handler = mockClient._handlers['event'];
      const aqId = 'aq_vote_2';
      const frame: any = {
        headers: { req_id: 'req_2' },
        body: {
          from: { userid: 'bob' },
          event: {
            template_card_event: {
              eventtype: 'template_card_event',
              task_id: aqId,
              selected_items: {
                selected_item: [
                  {
                    question_key: aqId,
                    option_ids: { option_id: [`${aqId}:选项二内容`] },
                  },
                ],
              },
            },
          },
        },
      };
      await handler(frame);
      expect(submitInbound).toHaveBeenCalledWith('mc_nested', [
        expect.objectContaining({ aqId, action: '选项二内容' }),
      ]);
    });

    it('button_interaction still works for permission approve', async () => {
      const submitInbound = jest
        .fn()
        .mockResolvedValue({ results: [{ ok: true }] });
      const ctx: any = { submitInbound, updateChannelRuntime: jest.fn() };
      const mockClient: any = {
        on: jest.fn((ev: string, fn: any) => {
          mockClient._handlers = mockClient._handlers ?? {};
          mockClient._handlers[ev] = fn;
        }),
        updateTemplateCard: jest.fn().mockResolvedValue({}),
      };
      (adapter as any).clients.set('mc_btn', mockClient);
      (adapter as any).bindListeners('mc_btn', mockClient, ctx);
      const handler = mockClient._handlers['event'];
      const frame: any = {
        headers: { req_id: 'req_3' },
        body: {
          from: { userid: 'u1' },
          event: {
            eventtype: 'template_card_event',
            task_id: 'aq_p1',
            event_key: 'aq_p1:approve',
          },
        },
      };
      await handler(frame);
      expect(submitInbound).toHaveBeenCalledWith('mc_btn', [
        expect.objectContaining({
          kind: 'card_action',
          aqId: 'aq_p1',
          action: 'approve',
        }),
      ]);
    });

    it('vote submit without selection is ignored not recorded as submit', async () => {
      const submitInbound = jest
        .fn()
        .mockResolvedValue({ results: [{ ok: true }] });
      const ctx: any = { submitInbound, updateChannelRuntime: jest.fn() };
      const mockClient: any = {
        on: jest.fn((ev: string, fn: any) => {
          mockClient._handlers = mockClient._handlers ?? {};
          mockClient._handlers[ev] = fn;
        }),
        updateTemplateCard: jest.fn().mockResolvedValue({}),
      };
      (adapter as any).clients.set('mc_empty', mockClient);
      (adapter as any).bindListeners('mc_empty', mockClient, ctx);
      const handler = mockClient._handlers['event'];
      const frame: any = {
        headers: { req_id: 'req_4' },
        body: {
          from: { userid: 'u2' },
          event: {
            eventtype: 'template_card_event',
            task_id: 'aq_vote_3',
            event_key: 'aq_vote_3:submit',
            selected_items: { selected_item: [] },
          },
        },
      };
      await handler(frame);
      expect(submitInbound).not.toHaveBeenCalled();
    });

    it('card update disables buttons for permission approve (button_list empty with replace_text)', async () => {
      const submitInbound = jest
        .fn()
        .mockResolvedValue({ results: [{ ok: true }] });
      const ctx: any = { submitInbound, updateChannelRuntime: jest.fn() };
      const mockClient: any = {
        on: jest.fn((ev: string, fn: any) => {
          mockClient._handlers = mockClient._handlers ?? {};
          mockClient._handlers[ev] = fn;
        }),
        updateTemplateCard: jest.fn().mockResolvedValue({}),
      };
      (adapter as any).clients.set('mc_disable_btn', mockClient);
      (adapter as any).bindListeners('mc_disable_btn', mockClient, ctx);
      const handler = mockClient._handlers['event'];
      const frame: any = {
        headers: { req_id: 'req_disable_1' },
        body: {
          from: { userid: 'u1' },
          event: {
            eventtype: 'template_card_event',
            task_id: 'aq_p1',
            event_key: 'aq_p1:approve',
          },
        },
      };
      await handler(frame);
      expect(mockClient.updateTemplateCard).toHaveBeenCalled();
      const card = mockClient.updateTemplateCard.mock.calls[0][1] as any;
      expect(card.task_id).toBe('aq_p1');
      expect(card.button_list).toEqual([]);
      expect(card.main_title.title).toBe('已批准');
    });

    it('vote card update sets checkbox disable true and is_called_before submitInbound', async () => {
      const callOrder: string[] = [];
      const submitInbound = jest.fn().mockImplementation(async () => {
        callOrder.push('submitInbound');
        return { results: [{ ok: true }] };
      });
      const ctx: any = { submitInbound, updateChannelRuntime: jest.fn() };
      const mockClient: any = {
        on: jest.fn((ev: string, fn: any) => {
          mockClient._handlers = mockClient._handlers ?? {};
          mockClient._handlers[ev] = fn;
        }),
        updateTemplateCard: jest.fn().mockImplementation(async () => {
          callOrder.push('updateTemplateCard');
          return {};
        }),
      };
      (adapter as any).clients.set('mc_disable_vote', mockClient);
      (adapter as any).bindListeners('mc_disable_vote', mockClient, ctx);
      const handler = mockClient._handlers['event'];
      const aqId = 'aq_vote_disable';
      const frame: any = {
        headers: { req_id: 'req_disable_vote' },
        body: {
          from: { userid: 'alice' },
          event: {
            eventtype: 'template_card_event',
            task_id: aqId,
            event_key: `${aqId}:submit`,
            selected_items: {
              selected_item: [
                {
                  question_key: aqId,
                  option_ids: { option_id: [`${aqId}:选项一`] },
                },
              ],
            },
          },
        },
      };
      await handler(frame);
      expect(mockClient.updateTemplateCard).toHaveBeenCalled();
      const card = mockClient.updateTemplateCard.mock.calls[0][1] as any;
      expect(card.card_type).toBe('vote_interaction');
      expect(card.checkbox.disable).toBe(true);
      expect(card.checkbox.option_list[0].text).toBe('选项一');
      expect(callOrder[0]).toBe('updateTemplateCard');
      expect(callOrder[1]).toBe('submitInbound');
    });

    it('2-button permission card update also disables (reject case)', async () => {
      const submitInbound = jest
        .fn()
        .mockResolvedValue({ results: [{ ok: true }] });
      const ctx: any = { submitInbound, updateChannelRuntime: jest.fn() };
      const mockClient: any = {
        on: jest.fn((ev: string, fn: any) => {
          mockClient._handlers = mockClient._handlers ?? {};
          mockClient._handlers[ev] = fn;
        }),
        updateTemplateCard: jest.fn().mockResolvedValue({}),
      };
      (adapter as any).clients.set('mc_disable_reject', mockClient);
      (adapter as any).bindListeners('mc_disable_reject', mockClient, ctx);
      const handler = mockClient._handlers['event'];
      const frame: any = {
        headers: { req_id: 'req_reject' },
        body: {
          from: { userid: 'u2' },
          event: {
            eventtype: 'template_card_event',
            task_id: 'aq_p2',
            event_key: 'aq_p2:reject',
          },
        },
      };
      await handler(frame);
      const card = mockClient.updateTemplateCard.mock.calls[0][1] as any;
      expect(card.main_title.title).toBe('已拒绝');
      expect(card.button_list).toEqual([]);
    });
  });

  describe('post-card placeholder handling (order bug fix)', () => {
    it('discardStream removes placeholder so final reply does not replace message before card', () => {
      adapter.registerStreamCorrelation('m_placeholder', {
        channelId: 'mc_1',
        frameHeaders: { req_id: 'req_ph' },
        streamId: 'stream_ph',
        fromUserId: 'user1',
        fromUserName: 'User1',
        chattype: 'group',
      });
      expect(adapter.getStream('m_placeholder')).toBeDefined();
      const had = adapter.discardStream('m_placeholder');
      expect(had).toBe(true);
      expect(adapter.getStream('m_placeholder')).toBeUndefined();
      expect(adapter.discardStream('m_placeholder')).toBe(false);
    });

    it('sendNewMessage sends markdown as new message after card (not finishStream replacement)', async () => {
      const mockClient: any = {
        sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }),
      };
      (adapter as any).clients.set('mc_newmsg', mockClient);
      (adapter as any).hosts.set('mc_newmsg', {
        getChannel: jest.fn().mockResolvedValue({
          id: 'mc_newmsg',
          config: { lastChatid: 'chat_after_card' },
        }),
      });
      const ok = await adapter.sendNewMessage('mc_newmsg', 'hello after card');
      expect(ok).toBe(true);
      expect(mockClient.sendMessage).toHaveBeenCalledWith(
        'chat_after_card',
        expect.objectContaining({ msgtype: 'markdown' }),
      );
      const body = mockClient.sendMessage.mock.calls[0][1];
      expect(body.markdown.content).toBe('hello after card');
    });

    it('sendNewMessage returns false when no client (keep health intact)', async () => {
      const ok = await adapter.sendNewMessage('mc_no_client_x', 'hi');
      expect(ok).toBe(false);
    });

    it('多群共用 bot：explicitChatId 覆盖渠道级 lastChatid（避免发到别的群）', async () => {
      const mockClient: any = {
        sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }),
        sendMediaMessage: jest.fn().mockResolvedValue({ errcode: 0 }),
        uploadMedia: jest.fn().mockResolvedValue({ media_id: 'mid_x' }),
      };
      (adapter as any).clients.set('mc_multi', mockClient);
      (adapter as any).hosts.set('mc_multi', {
        getChannel: jest.fn().mockResolvedValue({
          id: 'mc_multi',
          // 渠道级 lastChatid 已被别的群的入站覆盖
          config: { lastChatid: 'chat_GROUP_B' },
        }),
      });

      await adapter.sendNewMessage('mc_multi', 'hi', 'chat_GROUP_A');
      expect(mockClient.sendMessage).toHaveBeenCalledWith(
        'chat_GROUP_A',
        expect.objectContaining({ msgtype: 'markdown' }),
      );

      await adapter.sendMediaMessage('mc_multi', 'file', 'media_1', 'chat_GROUP_A');
      expect(mockClient.sendMediaMessage).toHaveBeenCalledWith(
        'chat_GROUP_A',
        'file',
        'media_1',
      );
    });

    it('未给 explicitChatId 时仍回退渠道级 lastChatid（单群场景不变）', async () => {
      const mockClient: any = {
        sendMediaMessage: jest.fn().mockResolvedValue({ errcode: 0 }),
      };
      (adapter as any).clients.set('mc_single', mockClient);
      (adapter as any).hosts.set('mc_single', {
        getChannel: jest.fn().mockResolvedValue({
          id: 'mc_single',
          config: { lastChatid: 'chat_only' },
        }),
      });

      await adapter.sendMediaMessage('mc_single', 'file', 'media_2');
      expect(mockClient.sendMediaMessage).toHaveBeenCalledWith(
        'chat_only',
        'file',
        'media_2',
      );
    });

    it('LRU and health still intact after post-card fix', () => {
      // LRU still 100
      for (let i = 0; i < 105; i++) {
        adapter.registerStreamCorrelation(`lru_${i}`, {
          channelId: 'mc_lru',
          frameHeaders: { req_id: `lr_${i}` },
          streamId: `s_${i}`,
        });
      }
      expect(adapter.getStreamSize()).toBe(100);
      // finishStream still works for simple case
      expect(typeof adapter.finishStream).toBe('function');
      expect(typeof adapter.sendNewMessage).toBe('function');
      expect(typeof adapter.discardStream).toBe('function');
    });
  });

  /**
   * 多 bot 回归（2026-10-03）。
   *
   * WecomAibotAdapter 是 NestJS default-scope 单例，被所有 wecom_aibot 渠道共享，
   * 内部持有 clients: Map<channelId, WSClient>。原 start() 遍历全部启用渠道，遇到
   * 已连接的渠道直接 `throw new Error('already started')`，**整个循环中断**。
   * resolveChannelIds() 没有 orderBy，MySQL 先返回存量 bot，于是运行时新增第二个
   * bot 后再次 start() → 撞上存量 bot 抛错 → 循环在到达新 bot 之前就结束了
   * → 新 bot 永远拿不到 WSClient → 它的入站消息永远收不到；调用方 `.catch(() => {})`
   * 把异常吞掉，HTTP 200 且无任何日志。
   *
   * 同类缺陷第二例：单个渠道 connect 失败时 `throw e`，同样中断其后所有渠道。
   */
  describe('multi-bot start/stop 回归（单例共享 clients map）', () => {
    it('一次 start() 同时连接两个渠道', async () => {
      const host = makeHost([{ id: 'mc_a' }, { id: 'mc_b' }]);
      await adapter.start(host);

      expect(adapter.getClient('mc_a')).toBeDefined();
      expect(adapter.getClient('mc_b')).toBeDefined();
      expect(mockClients).toHaveLength(2);
      expect(mockClients[0].connect).toHaveBeenCalled();
      expect(mockClients[1].connect).toHaveBeenCalled();
    });

    /**
     * 生产故障原样复现：先只有存量 bot，运行时新增一个 bot 后再次 start()。
     * 修复前这里抛 'already started'，mc_b 始终 undefined（新 bot 收不到消息）。
     */
    it('存量 bot 已在连接时再次 start()，新增 bot 仍能连上且不抛错', async () => {
      const host1 = makeHost([{ id: 'mc_a' }]);
      await adapter.start(host1);
      expect(adapter.getClient('mc_a')).toBeDefined();
      expect(adapter.getClient('mc_b')).toBeUndefined();

      // 运行时新增第二个 bot，再次 start()（生产里由 startEnabled 重新触发）
      const host2 = makeHost([{ id: 'mc_a' }, { id: 'mc_b' }]);
      await expect(adapter.start(host2)).resolves.not.toThrow();

      expect(adapter.getClient('mc_a')).toBeDefined();
      expect(adapter.getClient('mc_b')).toBeDefined();
      expect(mockClients).toHaveLength(2);
    });

    it('单个渠道 connect 失败不阻断其余渠道，且错误状态照常回写', async () => {
      mockConnectImpls.push(() => {
        throw new Error('boom');
      });
      const host = makeHost([{ id: 'mc_a' }, { id: 'mc_b' }]);

      await expect(adapter.start(host)).resolves.not.toThrow();

      expect(adapter.getClient('mc_a')).toBeUndefined();
      expect(adapter.getClient('mc_b')).toBeDefined();
      expect(mockClients[1].connect).toHaveBeenCalled();
      expect(host.updateChannelRuntime).toHaveBeenCalledWith('mc_a', {
        lastStatus: 'error',
        lastError: 'boom',
      });
      expect(host.updateChannelRuntime).toHaveBeenCalledWith('mc_b', {
        lastStatus: 'connecting',
      });
    });

    it('start() 不再乐观写 connected：须由 authenticated 事件驱动', async () => {
      const host = makeHost([{ id: 'mc_a' }]);
      await adapter.start(host);

      expect(host.updateChannelRuntime).toHaveBeenCalledWith('mc_a', {
        lastStatus: 'connecting',
      });
      expect(host.updateChannelRuntime).not.toHaveBeenCalledWith('mc_a', {
        lastStatus: 'connected',
      });

      const handlerOf = (ev: string) =>
        mockClients[0].on.mock.calls.find((c: any[]) => c[0] === ev)?.[1];
      // SDK 语义：connected = WS open，认证尚未完成
      await handlerOf('connected')();
      expect(host.updateChannelRuntime).toHaveBeenCalledWith('mc_a', {
        lastStatus: 'connecting',
      });

      await handlerOf('authenticated')();
      expect(host.updateChannelRuntime).toHaveBeenCalledWith('mc_a', {
        lastStatus: 'connected',
        lastError: '',
      });
    });

    it('stopChannel 只拆一个渠道，其余渠道与其内部状态完全不受影响', async () => {
      const host = makeHost([{ id: 'mc_a' }, { id: 'mc_b' }]);
      await adapter.start(host);

      adapter.registerStreamCorrelation('m_a', {
        channelId: 'mc_a',
        frameHeaders: {},
        streamId: 's_a',
      });
      adapter.registerStreamCorrelation('m_b', {
        channelId: 'mc_b',
        frameHeaders: {},
        streamId: 's_b',
      });
      adapter.setPendingOperatorForTask('t_a', {
        channelId: 'mc_a',
        fromUserId: 'u',
        fromUserName: 'n',
      });
      adapter.setPendingOperatorForTask('t_b', {
        channelId: 'mc_b',
        fromUserId: 'u',
        fromUserName: 'n',
      });
      adapter.setPendingOperatorForAq('aq_a', {
        channelId: 'mc_a',
        fromUserId: 'u',
        fromUserName: 'n',
      });
      adapter.setPendingOperatorForAq('aq_b', {
        channelId: 'mc_b',
        fromUserId: 'u',
        fromUserName: 'n',
      });

      const clearSpy = jest.spyOn(global, 'clearInterval');
      adapter.registerStreamCorrelation('m_a', {
        channelId: 'mc_a',
        frameHeaders: {},
        streamId: 's_a',
        spinnerTimer: setInterval(() => {}, 1000) as unknown as NodeJS.Timeout,
      });

      await adapter.stopChannel('mc_a');

      expect(adapter.getClient('mc_a')).toBeUndefined();
      expect(adapter.getClient('mc_b')).toBeDefined();
      expect(adapter.getStream('m_a')).toBeUndefined();
      expect(adapter.getStream('m_b')).toBeDefined();
      expect(adapter.getPendingOperatorForTask('t_a')).toBeUndefined();
      expect(adapter.getPendingOperatorForTask('t_b')).toBeDefined();
      expect(adapter.getPendingOperatorForAq('aq_a')).toBeUndefined();
      expect(adapter.getPendingOperatorForAq('aq_b')).toBeDefined();
      expect(clearSpy).toHaveBeenCalled();
      expect(mockClients[0].disconnect).toHaveBeenCalled();
      expect(mockClients[1].disconnect).not.toHaveBeenCalled();

      clearSpy.mockRestore();
    });

    it('stopChannel 幂等：未知渠道与重复调用都不抛错', async () => {
      const host = makeHost([{ id: 'mc_a' }, { id: 'mc_b' }]);
      await adapter.start(host);

      await expect(
        adapter.stopChannel('never_existed'),
      ).resolves.toBeUndefined();

      await adapter.stopChannel('mc_a');
      await expect(adapter.stopChannel('mc_a')).resolves.toBeUndefined();

      expect(adapter.getClient('mc_b')).toBeDefined();
      expect(mockClients[1].disconnect).not.toHaveBeenCalled();
    });

    it('stop() 仍全量拆干净（onModuleDestroy 走这条路径）', async () => {
      const host = makeHost([{ id: 'mc_a' }, { id: 'mc_b' }]);
      await adapter.start(host);
      adapter.registerStreamCorrelation('m_a', {
        channelId: 'mc_a',
        frameHeaders: {},
        streamId: 's_a',
      });
      expect(adapter.getStreamSize()).toBe(1);

      await adapter.stop();

      expect(adapter.getClient('mc_a')).toBeUndefined();
      expect(adapter.getClient('mc_b')).toBeUndefined();
      expect(adapter.getStreamSize()).toBe(0);
      expect(adapter.getPendingOperatorForTask('t_a')).toBeUndefined();
      expect(mockClients[0].disconnect).toHaveBeenCalled();
      expect(mockClients[1].disconnect).toHaveBeenCalled();
    });
  });

  describe('spinner 帧视觉一致性', () => {
    const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

    it('所有帧剥离零宽字符后是同一个字形', () => {
      const frames = (WecomAibotAdapter as any).SPINNER_FRAMES as string[];
      const visible = frames.map((f) => f.replace(ZERO_WIDTH, ''));
      expect(visible.length).toBeGreaterThan(1);
      expect(new Set(visible).size).toBe(1);
    });

    it('相邻帧仅靠零宽后缀区分（借其触发企微重绘，避免被去重缓存）', () => {
      const frames = (WecomAibotAdapter as any).SPINNER_FRAMES as string[];
      const suffixes = frames.map((f) => f.slice(-1));
      expect(new Set(suffixes).size).toBe(frames.length);
      for (const s of suffixes) expect(s).toMatch(ZERO_WIDTH);
    });
  });

  /**
   * 企微智能机器人协议不返回发送者姓名（`from` 只有 userid）。生产实测：
   * 值班群机器人由企业超管创建 → userid 明文（恰好形如人名，显示正常）；
   * 自行创建 → userid 为 35 字符加密 open_userid，直接展示是一串乱码。
   */
  describe('发送者名降级展示', () => {
    const ENC = 'woiGjxCgAALi1qEHavg6e3cK3ofow_yQ';
    const resolve = (name: unknown, id?: string) =>
      (WecomAibotAdapter as any).resolveSenderName(name, id) as string;

    it('payload 带 name 时原样采用（未来腾讯若补上该字段即自动生效）', () => {
      expect(resolve('GuoLong', ENC)).toBe('GuoLong');
      expect(resolve('  GuoLong  ', ENC)).toBe('GuoLong');
    });

    it('name 缺失时降级为可读标签，不暴露裸 userid', () => {
      expect(resolve(undefined, ENC)).toBe('企微用户-w_yQ');
      expect(resolve('', ENC)).toBe('企微用户-w_yQ');
      expect(resolve(null, ENC)).toBe('企微用户-w_yQ');
      expect(resolve(undefined, ENC)).not.toContain(ENC);
    });

    it('name 与 userid 都缺失时为空串', () => {
      expect(resolve(undefined, undefined)).toBe('');
      expect(resolve(undefined, '')).toBe('');
    });

    it('message.text 入站：senderName 用降级标签，真实 id 仍走 senderExternalId', async () => {
      const host = makeHost([{ id: 'mc_a' }]);
      host.submitInbound.mockResolvedValue({
        results: [{ ok: true, internalMessageId: 'm_1' }],
      });
      await adapter.start(host);

      const handler = mockClients[0].on.mock.calls.find(
        (c: any[]) => c[0] === 'message.text',
      )?.[1];
      expect(typeof handler).toBe('function');

      await handler({
        headers: { req_id: 'r1' },
        body: {
          msgid: 'm1',
          from: { userid: ENC },
          text: { content: 'nihao' },
          chattype: 'group',
        },
      });

      const [channelIdArg, cmds] = host.submitInbound.mock.calls[0];
      expect(channelIdArg).toBe('mc_a');
      expect(cmds[0].senderName).toBe('企微用户-w_yQ');
      expect(cmds[0].senderExternalId).toBe(ENC);
      expect(cmds[0].wecomUserName).toBe('企微用户-w_yQ');
      expect(cmds[0].text).toBe('nihao');
    });
  });
});
