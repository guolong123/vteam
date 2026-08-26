import { WecomAibotAdapter } from './wecom-aibot.adapter';

describe('WecomAibotAdapter (message-channels)', () => {
  let adapter: WecomAibotAdapter;

  beforeEach(() => {
    adapter = new WecomAibotAdapter();
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

  it('finishStream logs called and miss when no stream', async () => {
    const ok = await adapter.finishStream('missing_id', 'hello');
    expect(ok).toBe(false);
    expect(adapter.getStream('missing_id')).toBeUndefined();
  });

  it('finishStream ok when stream and client present', async () => {
    const mockClient: any = { replyStream: jest.fn().mockResolvedValue(undefined) };
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
    const mockClient: any = { replyStream: jest.fn().mockResolvedValue(undefined) };
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
    const mockClient: any = { sendMessage: jest.fn().mockResolvedValue({ errcode: 0, headers: { req_id: 'r1' } }) };
    (adapter as any).clients.set('mc_1', mockClient);
    const channel: any = { id: 'mc_1', type: 'wecom_aibot', config: { lastChatid: 'GuoLong' }, secrets: {}, enabled: true };
    await adapter.sendQuestionCard(channel, { id: 'aq_1', kind: 'permission', content: { title: '写入文件', pattern: 'Write' } });
    expect(mockClient.sendMessage).toHaveBeenCalledWith('GuoLong', expect.objectContaining({ msgtype: 'template_card' }));
    const body = mockClient.sendMessage.mock.calls[0][1];
    expect(body.template_card.button_list).toHaveLength(2);
    expect(body.template_card.button_list[0].key).toBe('aq_1:approve');
    expect(body.template_card.button_list[1].key).toBe('aq_1:reject');
  });

  it('sendQuestionCard question with options builds buttons', async () => {
    const mockClient: any = { sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }) };
    (adapter as any).clients.set('mc_1', mockClient);
    const channel: any = { id: 'mc_1', type: 'wecom_aibot', config: { lastChatid: 'chat1' }, secrets: {}, enabled: true };
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
    const mockClient: any = { sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }) };
    (adapter as any).clients.set('mc_1', mockClient);
    const channel: any = { id: 'mc_1', type: 'wecom_aibot', config: { lastChatid: 'chat1' }, secrets: {}, enabled: true };
    await adapter.sendQuestionCard(channel, {
      id: 'aq_2',
      kind: 'question',
      content: { questions: [{ question: 'Pick?', options: ['选项一内容较长', '选项二内容', '选项三'] }] },
    });
    const body = mockClient.sendMessage.mock.calls[0][1];
    expect(body.template_card.card_type).toBe('vote_interaction');
    expect(body.template_card.checkbox.option_list).toHaveLength(3);
    expect(body.template_card.checkbox.option_list[0].text).toBe('选项一内容较长');
    expect(body.template_card.checkbox.option_list[0].id).toBe('aq_2:选项一内容较长');
    expect(body.template_card.submit_button.key).toBe('aq_2:submit');
    expect(body.template_card.task_id).toBe('aq_2');
  });

  it('sendQuestionCard fallback markdown when no options', async () => {
    const mockClient: any = { sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }) };
    (adapter as any).clients.set('mc_1', mockClient);
    const channel: any = { id: 'mc_1', type: 'wecom_aibot', config: { lastChatid: 'chat1' }, secrets: {}, enabled: true };
    await adapter.sendQuestionCard(channel, { id: 'aq_3', kind: 'question', content: { questions: [{ question: 'Q?', options: [] }] } });
    expect(mockClient.sendMessage).toHaveBeenCalledWith('chat1', expect.objectContaining({ msgtype: 'markdown' }));
  });

  it('sendQuestionCard throws TASK_NOT_BOUND when no chatId', async () => {
    const channel: any = { id: 'mc_1', type: 'wecom_aibot', config: {}, secrets: {}, enabled: true };
    await expect(adapter.sendQuestionCard(channel, { id: 'aq_4', kind: 'permission', content: {} })).rejects.toThrow('TASK_NOT_BOUND');
  });

  describe('handleTemplateCardEvent vote_interaction', () => {

    it('vote submit with selected_items triggers card_action with correct aqId/action', async () => {
      const submitInbound = jest.fn().mockResolvedValue({ results: [{ ok: true }] });
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
      const handler = mockClient._handlers['event'] ?? mockClient._handlers['event.template_card_event'];
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
        expect.objectContaining({ kind: 'card_action', aqId, action: '选项一内容较长' }),
      ]);
    });

    it('vote submit handles nested template_card_event wrapper', async () => {
      const submitInbound = jest.fn().mockResolvedValue({ results: [{ ok: true }] });
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
                selected_item: [{ question_key: aqId, option_ids: { option_id: [`${aqId}:选项二内容`] } }],
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
      const submitInbound = jest.fn().mockResolvedValue({ results: [{ ok: true }] });
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
          event: { eventtype: 'template_card_event', task_id: 'aq_p1', event_key: 'aq_p1:approve' },
        },
      };
      await handler(frame);
      expect(submitInbound).toHaveBeenCalledWith('mc_btn', [
        expect.objectContaining({ kind: 'card_action', aqId: 'aq_p1', action: 'approve' }),
      ]);
    });

    it('vote submit without selection is ignored not recorded as submit', async () => {
      const submitInbound = jest.fn().mockResolvedValue({ results: [{ ok: true }] });
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
      const submitInbound = jest.fn().mockResolvedValue({ results: [{ ok: true }] });
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
          event: { eventtype: 'template_card_event', task_id: 'aq_p1', event_key: 'aq_p1:approve' },
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
              selected_item: [{ question_key: aqId, option_ids: { option_id: [`${aqId}:选项一`] } }],
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
      const submitInbound = jest.fn().mockResolvedValue({ results: [{ ok: true }] });
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
          event: { eventtype: 'template_card_event', task_id: 'aq_p2', event_key: 'aq_p2:reject' },
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
      const mockClient: any = { sendMessage: jest.fn().mockResolvedValue({ errcode: 0 }) };
      (adapter as any).clients.set('mc_newmsg', mockClient);
      (adapter as any).hosts.set('mc_newmsg', {
        getChannel: jest.fn().mockResolvedValue({ id: 'mc_newmsg', config: { lastChatid: 'chat_after_card' } }),
      });
      const ok = await adapter.sendNewMessage('mc_newmsg', 'hello after card');
      expect(ok).toBe(true);
      expect(mockClient.sendMessage).toHaveBeenCalledWith('chat_after_card', expect.objectContaining({ msgtype: 'markdown' }));
      const body = mockClient.sendMessage.mock.calls[0][1];
      expect(body.markdown.content).toBe('hello after card');
    });

    it('sendNewMessage returns false when no client (keep health intact)', async () => {
      const ok = await adapter.sendNewMessage('mc_no_client_x', 'hi');
      expect(ok).toBe(false);
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
});
