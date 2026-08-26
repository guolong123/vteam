import { Injectable, Logger } from '@nestjs/common';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import {
  InboundCommand,
  MessageAdapter,
  MessageChannelResolved,
  MessageHost,
} from '../message-adapter';
import {
  MESSAGE_CHANNEL_TYPES,
  INTEGRATIONS_ERRORS,
} from '../message-channel.constants';

/**
 * WeCom AiBot adapter — WS inbound + outbound question card.
 * Inbound: WS message.text + template_card_event handling.
 * Outbound: sendQuestionCard sends button_interaction template_card via WSClient.sendMessage.
 */
@Injectable()
export class WecomAibotAdapter extends MessageAdapter {
  readonly type = MESSAGE_CHANNEL_TYPES.wecom_aibot;

  supportsInbound = true;

  private readonly logger = new Logger(WecomAibotAdapter.name);

  private clients = new Map<string, WSClient>();
  private hosts = new Map<string, MessageHost>();
  private attachedHost: MessageHost | null = null;

  private readonly streams = new Map<
    string,
    {
      channelId: string;
      frameHeaders: unknown;
      streamId: string;
      fromUserId?: string;
      fromUserName?: string;
      chattype?: string;
      spinnerTimer?: NodeJS.Timeout | null;
    }
  >();
  private static readonly STREAM_LIMIT = 100;
  // Zero-width suffix forces WeCom markdown diff repaint while visually icon-only (⏳ vs ⌛ alone may be deduped/cached by WeCom client)
  private static readonly SPINNER_FRAMES = ['⏳\u200B', '⌛\u200C'];
  private static readonly SPINNER_INTERVAL_MS = 1000;

  private readonly reconnectCounts = new Map<string, number>();

  /**
   * Card operator pending map for post-question @ directed reply.
   * Key: taskId (or aqId as fallback) -> operator info so that the next
   * agent message after questionsService.reply can @ the operator who clicked,
   * not the original sender. TTL 10 min; consumed after first use or expiry.
   */
  private readonly taskPendingOperators = new Map<
    string,
    {
      taskId?: string;
      aqId?: string;
      channelId: string;
      fromUserId: string;
      fromUserName: string;
      chattype?: string;
      frameHeaders?: unknown;
      streamId?: string;
      at: number;
    }
  >();
  private readonly QUESTION_OPERATOR_TTL_MS = 10 * 60 * 1000;

  /** Also map by aqId for direct lookup before taskId is resolved */
  private readonly aqOperatorMap = new Map<
    string,
    { channelId: string; fromUserId: string; fromUserName: string; chattype?: string; at: number }
  >();

  setPendingOperatorForTask(
    taskId: string,
    info: { channelId: string; fromUserId: string; fromUserName: string; chattype?: string; aqId?: string; frameHeaders?: unknown; streamId?: string },
  ): void {
    const now = Date.now();
    this.taskPendingOperators.set(taskId, { taskId, ...info, at: now });
    if (info.aqId) {
      this.aqOperatorMap.set(info.aqId, { channelId: info.channelId, fromUserId: info.fromUserId, fromUserName: info.fromUserName, chattype: info.chattype, at: now });
    }
    this.logger.log(`wecom setPendingOperatorForTask taskId=${taskId} aqId=${info.aqId ?? ''} fromUserId=${info.fromUserId} fromUserName=${info.fromUserName} chattype=${info.chattype ?? ''}`);
  }

  setPendingOperatorForAq(
    aqId: string,
    info: { channelId: string; fromUserId: string; fromUserName: string; chattype?: string },
  ): void {
    this.aqOperatorMap.set(aqId, { ...info, at: Date.now() });
    this.logger.log(`wecom setPendingOperatorForAq aqId=${aqId} fromUserId=${info.fromUserId} fromUserName=${info.fromUserName}`);
  }

  getPendingOperatorForTask(taskId: string):
    | { fromUserId: string; fromUserName: string; chattype?: string; channelId: string; aqId?: string }
    | undefined {
    const e = this.taskPendingOperators.get(taskId);
    if (!e) return undefined;
    if (Date.now() - e.at > this.QUESTION_OPERATOR_TTL_MS) {
      this.taskPendingOperators.delete(taskId);
      if (e.aqId) this.aqOperatorMap.delete(e.aqId);
      return undefined;
    }
    return { fromUserId: e.fromUserId, fromUserName: e.fromUserName, chattype: e.chattype, channelId: e.channelId, aqId: e.aqId };
  }

  consumePendingOperatorForTask(taskId: string):
    | { fromUserId: string; fromUserName: string; chattype?: string; channelId: string; aqId?: string }
    | undefined {
    const v = this.getPendingOperatorForTask(taskId);
    if (v) {
      this.taskPendingOperators.delete(taskId);
      if (v.aqId) this.aqOperatorMap.delete(v.aqId);
      this.logger.log(`wecom consumePendingOperatorForTask taskId=${taskId} fromUserId=${v.fromUserId}`);
    }
    return v;
  }

  getPendingOperatorForAq(aqId: string):
    | { channelId: string; fromUserId: string; fromUserName: string; chattype?: string }
    | undefined {
    const e = this.aqOperatorMap.get(aqId);
    if (!e) return undefined;
    if (Date.now() - e.at > this.QUESTION_OPERATOR_TTL_MS) {
      this.aqOperatorMap.delete(aqId);
      return undefined;
    }
    return e;
  }

  attach(host: MessageHost): void {
    this.attachedHost = host;
  }

  registerStreamCorrelation(
    internalMessageId: string,
    ref: {
      channelId: string;
      frameHeaders: unknown;
      streamId: string;
      fromUserId?: string;
      fromUserName?: string;
      chattype?: string;
      spinnerTimer?: NodeJS.Timeout | null;
    },
  ): void {
    if (this.streams.size >= WecomAibotAdapter.STREAM_LIMIT) {
      const firstKey = this.streams.keys().next().value as string | undefined;
      if (firstKey) {
        const evicted = this.streams.get(firstKey);
        if (evicted?.spinnerTimer) {
          try { clearInterval(evicted.spinnerTimer); } catch {}
        }
        this.streams.delete(firstKey);
      }
    }
    const existing = this.streams.get(internalMessageId);
    if (existing?.spinnerTimer) {
      try { clearInterval(existing.spinnerTimer); } catch {}
    }
    this.streams.set(internalMessageId, ref);
    this.logger.log(
      `wecom registerStreamCorrelation internalMessageId=${internalMessageId} channelId=${ref.channelId} streamId=${ref.streamId} fromUserId=${ref.fromUserId ?? ''} chattype=${ref.chattype ?? ''} size=${this.streams.size}`,
    );
  }

  getStream(
    refId: string,
  ):
    | {
        channelId: string;
        frameHeaders: unknown;
        streamId: string;
        fromUserId?: string;
        fromUserName?: string;
        chattype?: string;
        spinnerTimer?: NodeJS.Timeout | null;
      }
    | undefined {
    return this.streams.get(refId);
  }

  getPendingUser(
    internalMessageId: string,
  ):
    | { fromUserId?: string; fromUserName?: string; chattype?: string }
    | undefined {
    const ref = this.streams.get(internalMessageId);
    if (!ref) return undefined;
    return {
      fromUserId: ref.fromUserId,
      fromUserName: ref.fromUserName,
      chattype: ref.chattype,
    };
  }

  getStreamSize(): number {
    return this.streams.size;
  }

  getClient(channelId: string): WSClient | undefined {
    return this.clients.get(channelId);
  }

  async start(ctx: MessageHost): Promise<void> {
    const channelIds = await this.resolveChannelIds(ctx);
    if (channelIds.length === 0) {
      this.logger.warn('wecom-aibot start: no enabled channels found');
      return;
    }
    for (const channelId of channelIds) {
      if (this.clients.has(channelId)) {
        throw new Error('already started');
      }
      const ch = await ctx.getChannel(channelId);
      if (!ch) {
        this.logger.warn(
          `wecom-aibot start: channel ${channelId} not found, skip`,
        );
        continue;
      }
      const secrets = (ch.secrets ?? {}) as Record<string, any>;
      const botId: string | undefined =
        secrets.botId ?? secrets.botID ?? secrets.bot_id;
      const secret: string | undefined = secrets.secret;
      if (!botId || !secret) {
        this.logger.warn(
          `wecom-aibot start: channel ${channelId} missing botId/secret, skip`,
        );
        await ctx.updateChannelRuntime(channelId, {
          lastStatus: 'error',
          lastError: 'missing botId/secret',
        });
        continue;
      }
      const client = new WSClient({
        botId,
        secret,
        maxReconnectAttempts: -1,
        heartbeatInterval: 30000,
      });
      this.clients.set(channelId, client);
      this.hosts.set(channelId, ctx);
      this.bindListeners(channelId, client, ctx);
      try {
        client.connect();
        await ctx.updateChannelRuntime(channelId, { lastStatus: 'connected' });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        this.logger.error(
          `wecom-aibot connect failed channel=${channelId}: ${msg}`,
        );
        await ctx.updateChannelRuntime(channelId, {
          lastStatus: 'error',
          lastError: msg.slice(0, 512),
        });
        this.clients.delete(channelId);
        this.hosts.delete(channelId);
        throw e;
      }
    }
  }

  private async resolveChannelIds(ctx: MessageHost): Promise<string[]> {
    const maybeAny = ctx as unknown as Record<string, unknown>;
    const candidates: unknown[] = [ctx, this.attachedHost];
    for (const cand of candidates) {
      const p = (cand as Record<string, unknown> | null)?.['prisma'] as
        | {
            integrationChannel?: {
              findMany: (q: unknown) => Promise<Array<{ id: string }>>;
            };
            messageChannel?: {
              findMany: (q: unknown) => Promise<Array<{ id: string }>>;
            };
          }
        | undefined;
      if (p?.integrationChannel?.findMany) {
        try {
          const rows = await p.integrationChannel.findMany({
            where: { type: MESSAGE_CHANNEL_TYPES.wecom_aibot, enabled: true },
            select: { id: true },
          });
          if (rows.length > 0) return rows.map((r) => r.id);
        } catch {}
      }
      if (p?.messageChannel?.findMany) {
        try {
          const rows = await p.messageChannel.findMany({
            where: { type: MESSAGE_CHANNEL_TYPES.wecom_aibot, enabled: true },
            select: { id: true },
          });
          if (rows.length > 0) return rows.map((r) => r.id);
        } catch {}
      }
    }
    const regPrisma = (
      ctx as unknown as {
        prisma?: {
          integrationChannel?: { findMany: (q: unknown) => Promise<unknown> };
          messageChannel?: { findMany: (q: unknown) => Promise<unknown> };
        };
      }
    )?.prisma;
    if (regPrisma?.messageChannel?.findMany) {
      try {
        const rows = await (
          regPrisma.messageChannel.findMany as (
            q: unknown,
          ) => Promise<Array<{ id: string }>>
        )({
          where: { type: MESSAGE_CHANNEL_TYPES.wecom_aibot, enabled: true },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      } catch {
        return [];
      }
    }
    if (regPrisma?.integrationChannel?.findMany) {
      try {
        const rows = await (
          regPrisma.integrationChannel.findMany as (
            q: unknown,
          ) => Promise<Array<{ id: string }>>
        )({
          where: { type: MESSAGE_CHANNEL_TYPES.wecom_aibot, enabled: true },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      } catch {
        return [];
      }
    }
    return [];
  }

  private bindListeners(
    channelId: string,
    client: WSClient,
    ctx: MessageHost,
  ): void {
    (
      client as unknown as {
        on: (ev: string, fn: (...args: unknown[]) => unknown) => unknown;
      }
    ).on('message.text', async (frame: unknown) => {
      const f = frame as {
        headers?: unknown;
        body?: {
          msgid: string;
          text?: { content: string };
          from?: { userid: string; name?: string };
          chatid?: string;
          chattype?: string;
        };
      };
      const body = f.body;
      if (!body) return;
      const rawContent = body.text?.content ?? '';
      const text = rawContent.replace(/^@[^ ]+\s*/, '').trim();
      const fromUserId = body.from?.userid;
      const fromUserName = body.from?.name ?? fromUserId ?? '';
      const chattype = body.chattype ?? 'single';
      if (!text) {
        try {
          await client.replyStream(
            f as { headers: { req_id: string } },
            generateReqId('stream'),
            '消息内容为空，已忽略。',
            true,
          );
        } catch {}
        try {
          const effectiveChatId = body.chatid ?? body.from?.userid ?? null;
          await ctx.updateChannelRuntime(channelId, {
            configMerge: {
              lastChatid: effectiveChatId,
              lastChattype: body.chattype,
              lastSenderExternalId: body.from?.userid ?? null,
            },
          });
        } catch {}
        return;
      }
      const cmd: InboundCommand = {
        kind: 'post_message',
        text,
        senderExternalId: fromUserId,
        senderName: fromUserName,
        dedupKey: body.msgid,
        chattype,
        wecomUserId: fromUserId,
        wecomUserName: fromUserName,
      };
      const streamId = generateReqId('stream');
      const spinnerFrames = WecomAibotAdapter.SPINNER_FRAMES;
      let spinnerIndex = 0;
      let spinnerTimer: NodeJS.Timeout | null = null;
      const frameHeadersForSpinner = (f as { headers?: unknown }).headers ?? f;
      const spinnerPayload = { headers: frameHeadersForSpinner } as unknown as { headers: { req_id: string } };
      try {
        await client.replyStream(
          spinnerPayload,
          streamId,
          spinnerFrames[0],
          false,
        );
      } catch (e) {
        this.logger.warn(
          `wecom replyStream placeholder failed channel=${channelId}: ${(e as Error).message}`,
        );
      }
      spinnerIndex = 1;
      this.logger.log(`wecom spinner start stream=${streamId} channel=${channelId} interval=${WecomAibotAdapter.SPINNER_INTERVAL_MS}ms frames=${JSON.stringify(spinnerFrames)}`);
      try {
        let pendingTick = false;
        spinnerTimer = setInterval(() => {
          if (pendingTick) {
            this.logger.warn(`wecom spinner tick skipped (prev pending) stream=${streamId}`);
            return;
          }
          const tickText = spinnerFrames[spinnerIndex++ % spinnerFrames.length];
          const tickAt = new Date().toISOString();
          this.logger.log(`wecom spinner tick ${JSON.stringify(tickText)} for stream ${streamId} at ${tickAt} idx=${spinnerIndex - 1}`);
          pendingTick = true;
          client.replyStream(spinnerPayload, streamId, tickText, false).then((res) => {
            pendingTick = false;
            const rc = (res as any)?.errcode;
            if (typeof rc !== 'undefined' && rc !== 0) {
              this.logger.warn(`wecom spinner replyStream non-zero errcode stream=${streamId} tickText=${JSON.stringify(tickText)} res=${JSON.stringify(res).slice(0, 500)}`);
            } else {
              this.logger.log(`wecom spinner replyStream ok stream=${streamId} tickText=${JSON.stringify(tickText)}`);
            }
          }).catch((e) => {
            pendingTick = false;
            this.logger.warn(`wecom spinner replyStream failed stream=${streamId} tickText=${JSON.stringify(tickText)} err=${(e as Error)?.message ?? String(e)}`);
          });
        }, WecomAibotAdapter.SPINNER_INTERVAL_MS);
        if ((spinnerTimer as any)?.unref) (spinnerTimer as any).unref();
      } catch (e) {
        this.logger.warn(`wecom spinner setInterval failed stream=${streamId}: ${(e as Error)?.message ?? String(e)}`);
      }
      let result:
        | { results: Array<{ ok: boolean; internalMessageId?: string }> }
        | undefined;
      try {
        result = await ctx.submitInbound(channelId, [cmd]);
      } catch (e) {
        this.logger.error(
          `wecom submitInbound failed channel=${channelId}: ${(e as Error).message}`,
        );
      }
      const first = result?.results?.[0];
      if (first?.ok && first.internalMessageId) {
        this.logger.log(`wecom spinner registered stream=${streamId} internalMessageId=${first.internalMessageId} hasTimer=${!!spinnerTimer}`);
        this.registerStreamCorrelation(first.internalMessageId, {
          channelId,
          frameHeaders: (f as { headers?: unknown }).headers ?? f,
          streamId,
          fromUserId,
          fromUserName,
          chattype,
          spinnerTimer,
        });
        try {
          if (
            typeof (ctx as MessageHost).registerStreamCorrelation === 'function'
          ) {
            (ctx as MessageHost).registerStreamCorrelation!(
              first.internalMessageId,
              {
                channelId,
                frameHeaders: (f as { headers?: unknown }).headers ?? f,
                streamId,
                fromUserId,
                fromUserName,
                chattype,
                spinnerTimer,
              } as any,
            );
          }
        } catch {}
      } else {
        if (spinnerTimer) {
          try { clearInterval(spinnerTimer); } catch {}
          this.logger.log(`wecom spinner cleared (no internalMessageId) stream=${streamId}`);
        }
      }
      try {
        const effectiveChatId = body.chatid ?? body.from?.userid ?? null;
        await ctx.updateChannelRuntime(channelId, {
          configMerge: {
            lastChatid: effectiveChatId,
            lastChattype: body.chattype,
            lastSenderExternalId: body.from?.userid ?? null,
          },
        });
      } catch (e) {
        this.logger.warn(
          `wecom updateChannelRuntime configMerge failed: ${(e as Error).message}`,
        );
      }
    });

    const fallbackTypes = [
      'message.image',
      'message.mixed',
      'message.voice',
      'message.file',
      'message.video',
    ];
    for (const ev of fallbackTypes) {
      (
        client as unknown as {
          on: (ev: string, fn: (...args: unknown[]) => unknown) => unknown;
        }
      ).on(ev, async (frame: unknown) => {
        const f = frame as {
          headers?: unknown;
          body?: { chatid?: string; chattype?: string };
        };
        try {
          await client.replyStream(
            f as { headers: { req_id: string } },
            generateReqId('stream'),
            '暂不支持该消息类型，请发送文本。',
            true,
          );
        } catch {}
        this.logger.log(
          `wecom inbound skipped unsupported ${ev} channel=${channelId}`,
        );
        const body = (f as {
          body?: { chatid?: string; chattype?: string; from?: { userid?: string } };
        }).body;
        const effectiveChatId = body?.chatid ?? (f as { body?: { from?: { userid?: string } } }).body?.from?.userid ?? null;
        const effectiveChattype = body?.chattype;
        const senderExternalId = (f as { body?: { from?: { userid?: string } } }).body?.from?.userid ?? null;
        if (effectiveChatId) {
          try {
            await ctx.updateChannelRuntime(channelId, {
              configMerge: {
                lastChatid: effectiveChatId,
                lastChattype: effectiveChattype,
                lastSenderExternalId: senderExternalId,
              },
            });
          } catch {}
        }
      });
    }

    const handleTemplateCardEvent = async (frame: unknown) => {
      const f = frame as {
        headers?: { req_id: string };
        body?: {
          event?: any;
          from?: { userid: string };
          chatid?: string;
          chattype?: string;
        };
      };
      const body = f.body;
      const rawEv: any = body?.event;
      try {
        const rawJson = JSON.stringify(body ?? f)?.slice(0, 4000);
        const evPreview = rawEv ? JSON.stringify(rawEv).slice(0, 3000) : 'null';
        this.logger.log(
          `wecom template_card_event received channel=${channelId} headers=${JSON.stringify((f as any).headers ?? {})} body=${rawJson}`,
        );
        this.logger.log(
          `wecom template_card_event rawEvent=${evPreview}`,
        );
      } catch {}
      if (!rawEv) {
        this.logger.warn(`wecom template_card_event skipped: missing event channel=${channelId}`);
        return;
      }
      const ev: any = rawEv.template_card_event ?? rawEv;
      const eventtype: string | undefined = rawEv.eventtype ?? ev.eventtype ?? rawEv.event_type ?? ev.event_type;
      const cardTypeRaw: string | undefined = ev.card_type ?? rawEv.card_type ?? ev.cardType ?? rawEv.cardType;
      const isTemplateCard = eventtype === 'template_card_event';
      const hasVotePayload = !!(ev.selected_items ?? rawEv.selected_items ?? ev.selectedItems ?? rawEv.selectedItems ?? ev.selected_item ?? rawEv.selected_item);
      if (!isTemplateCard && !hasVotePayload) {
        this.logger.log(
          `wecom template_card_event ignored non-card event channel=${channelId} eventtype=${String(eventtype ?? 'undefined')} card_type=${String(cardTypeRaw ?? 'undefined')}`,
        );
        return;
      }
      if (!isTemplateCard && hasVotePayload) {
        this.logger.log(
          `wecom template_card_event permissive accept vote-like payload channel=${channelId} eventtype=${String(eventtype ?? 'undefined')} card_type=${String(cardTypeRaw ?? 'undefined')}`,
        );
      }

      const taskId: string | undefined = ev.task_id ?? rawEv.task_id ?? ev.taskId ?? rawEv.taskId;
      let eventKey: string | undefined = ev.event_key ?? rawEv.event_key ?? ev.eventKey ?? rawEv.eventKey ?? rawEv.key ?? ev.key;
      const selectedItems: any =
        ev.selected_items ?? rawEv.selected_items ?? ev.selectedItems ?? rawEv.selectedItems ?? ev.selected_item ?? rawEv.selected_item;

      try {
        this.logger.log(
          `wecom template_card_event parsed channel=${channelId} eventtype=${String(eventtype)} card_type=${String(cardTypeRaw ?? 'undefined')} task_id=${String(taskId ?? 'undefined')} event_key=${String(eventKey ?? 'undefined')} selected_items=${JSON.stringify(selectedItems ?? null).slice(0, 2000)}`,
        );
      } catch {}

      let aqId: string | undefined;
      let action: string | undefined;

      const extractSelectedOptionId = (si: any): string | undefined => {
        if (!si) return undefined;
        let items: any[] | undefined;
        if (Array.isArray(si)) items = si;
        else if (Array.isArray(si.selected_item)) items = si.selected_item;
        else if (Array.isArray(si.selected_items)) items = si.selected_items;
        else if (si.selected_item && !Array.isArray(si.selected_item)) items = [si.selected_item];
        else if ((si as any).question_key && ((si as any).option_ids || (si as any).option_id)) {
          items = [si];
        } else return undefined;
        if (!items || items.length === 0) return undefined;
        const first = items[0];
        const oidContainer = first.option_ids ?? first.optionIds ?? first.option_id ?? first.optionId ?? first.options ?? first.optionIds;
        if (!oidContainer) {
          if (typeof first.id === 'string') return first.id;
          if (typeof first.option_id === 'string') return first.option_id;
          return undefined;
        }
        if (typeof oidContainer === 'string') return oidContainer;
        if (Array.isArray(oidContainer)) return oidContainer[0];
        if (typeof oidContainer === 'object') {
          const arr = (oidContainer as any).option_id ?? (oidContainer as any).optionId ?? (oidContainer as any).option_ids;
          if (Array.isArray(arr)) return arr[0];
          if (typeof arr === 'string') return arr;
          if (typeof (oidContainer as any).option_id === 'string') return (oidContainer as any).option_id;
          if (typeof (oidContainer as any).option_id === 'undefined' && typeof oidContainer === 'object') {
            const vals = Object.values(oidContainer as Record<string, unknown>);
            for (const v of vals) {
              if (typeof v === 'string') return v;
              if (Array.isArray(v) && typeof v[0] === 'string') return v[0] as string;
            }
          }
        }
        return undefined;
      };

      const selectedOptionId = extractSelectedOptionId(selectedItems);
      try {
        this.logger.log(
          `wecom template_card_event selectedOptionId=${String(selectedOptionId ?? 'undefined')} channel=${channelId}`,
        );
      } catch {}

      if (selectedOptionId && typeof selectedOptionId === 'string') {
        const sep2 = selectedOptionId.indexOf(':');
        if (sep2 !== -1) {
          aqId = taskId ?? selectedOptionId.slice(0, sep2) ?? ev.question_key ?? rawEv.question_key;
          action = selectedOptionId.slice(sep2 + 1);
        } else {
          const qk: string | undefined = ev.question_key ?? rawEv.question_key ?? (selectedItems as any)?.selected_item?.[0]?.question_key;
          let qk2: string | undefined = qk;
          if (!qk2 && selectedItems) {
            const siItems = (selectedItems as any).selected_item;
            if (Array.isArray(siItems) && siItems[0]?.question_key) qk2 = siItems[0].question_key;
            else if (!Array.isArray(siItems) && (siItems as any)?.question_key) qk2 = (siItems as any).question_key;
            if (!qk2 && Array.isArray(selectedItems) && (selectedItems[0] as any)?.question_key) qk2 = (selectedItems[0] as any).question_key;
          }
          aqId = taskId ?? qk2 ?? (eventKey ? eventKey.slice(0, eventKey.indexOf(':') === -1 ? eventKey.length : eventKey.indexOf(':')) : undefined);
          action = selectedOptionId;
          if (!aqId && eventKey && eventKey.includes(':')) {
            aqId = eventKey.slice(0, eventKey.indexOf(':'));
          }
          if (!aqId && qk2) aqId = qk2;
        }
        if (!aqId) aqId = taskId;
        if (action === 'submit') {
          this.logger.warn(
            `wecom vote submit without selection ignored channel=${channelId} aqId=${String(aqId)} selectedOptionId=${selectedOptionId} eventKey=${String(eventKey)}`,
          );
          return;
        }
        if (!aqId || !action) {
          this.logger.warn(
            `wecom template_card_event vote parse failed missing aqId/action channel=${channelId} aqId=${String(aqId)} action=${String(action)} selectedOptionId=${selectedOptionId} taskId=${String(taskId)}`,
          );
          return;
        }
      } else {
        if (!eventKey || typeof eventKey !== 'string') {
          this.logger.warn(
            `wecom template_card_event no selected_items and no event_key channel=${channelId} raw=${JSON.stringify(rawEv).slice(0, 800)}`,
          );
          return;
        }
        const sep = eventKey.indexOf(':');
        if (sep === -1) {
          this.logger.warn(
            `wecom template_card_event event_key missing separator channel=${channelId} event_key=${eventKey}`,
          );
          return;
        }
        aqId = eventKey.slice(0, sep);
        action = eventKey.slice(sep + 1);
        if (action === 'submit' && hasVotePayload) {
          this.logger.warn(
            `wecom template_card_event vote submit without selected_items ignored channel=${channelId} aqId=${aqId}`,
          );
          return;
        }
        if (!aqId || !action) {
          this.logger.warn(
            `wecom template_card_event button parse empty aqId/action channel=${channelId} event_key=${eventKey}`,
          );
          return;
        }
        if (taskId && typeof taskId === 'string' && taskId.length > 0) {
          aqId = taskId;
        }
      }
      const operatorExternalId = body?.from?.userid;
      const operatorExternalName = (body?.from as any)?.name ?? (body as any)?.from_name ?? operatorExternalId ?? '';
      const operatorChattype = body?.chattype;
      const operatorChatId = body?.chatid as string | undefined;
      this.logger.log(`wecom template_card_event operator userid=${operatorExternalId ?? ''} name=${operatorExternalName ?? ''} chattype=${operatorChattype ?? ''}`);
      if (aqId && operatorExternalId) {
        try {
          this.setPendingOperatorForAq(aqId, {
            channelId,
            fromUserId: operatorExternalId,
            fromUserName: operatorExternalName || operatorExternalId,
            chattype: operatorChattype,
          });
        } catch {}
      }
      const userLabel = operatorExternalId ?? '用户';
      const display =
        action === 'approve'
          ? '已批准'
          : action === 'reject'
            ? '已拒绝'
            : `已选择 ${action}`;
      const isVoteCard = !!selectedItems;
      // Optimistic card update BEFORE submitInbound to ensure card update happens before reply
      // and to gray/disable buttons immediately (prevent double-click). This also ensures
      // the subsequent reply message (via worker) will have a strictly later timestamp/id.
      if (taskId) {
        try {
          let optimisticCard: unknown;
          if (isVoteCard) {
            optimisticCard = {
              card_type: 'vote_interaction',
              main_title: { title: display, desc: `由 ${userLabel} 处理` },
              checkbox: {
                question_key: String(aqId).slice(0, 1024),
                option_list: [
                  {
                    id: `${aqId}:${action}`.slice(0, 128),
                    text: String(action).slice(0, 17) || '已选择',
                    is_checked: true,
                  },
                ],
                mode: 0,
                disable: true,
              },
              submit_button: {
                text: '已提交',
                key: `${aqId}:disabled`.slice(0, 1024),
              },
              task_id: taskId,
            };
          } else {
            // button_interaction: empty button_list disables interaction (no active buttons)
            // plus replace_text for gray effect where supported
            const payload: Record<string, unknown> = {
              card_type: 'button_interaction',
              main_title: { title: display, desc: `由 ${userLabel} 处理` },
              button_list: [],
              task_id: taskId,
            };
            (payload as Record<string, unknown>).replace_text = display;
            optimisticCard = payload;
          }
          await (
            client as unknown as {
              updateTemplateCard: (
                frame: unknown,
                card: unknown,
              ) => Promise<unknown>;
            }
          ).updateTemplateCard(
            f as unknown as { headers: { req_id: string } },
            optimisticCard,
          );
          this.logger.log(
            `wecom card optimistic update ok taskId=${taskId} aqId=${aqId} action=${action} display=${display} isVote=${isVoteCard}`,
          );
        } catch (e) {
          this.logger.warn(
            `wecom optimistic card update failed taskId=${taskId}: ${(e as Error).message}`,
          );
        }
      }

      const cmd: InboundCommand = {
        kind: 'card_action',
        aqId,
        action,
        operatorExternalId,
        operatorExternalName,
        operatorName: operatorExternalName,
        chattype: operatorChattype,
        chatId: operatorChatId,
        channelId,
      } as InboundCommand;
      let result: { results: Array<{ ok: boolean }> } | undefined;
      try {
        result = await ctx.submitInbound(channelId, [cmd]);
      } catch (e) {
        this.logger.error(
          `wecom card_action submitInbound failed channel=${channelId}: ${(e as Error).message}`,
        );
      }
      const ok = result?.results?.[0]?.ok === true;
      if (!ok && taskId) {
        try {
          await (
            client as unknown as {
              updateTemplateCard: (
                frame: unknown,
                card: unknown,
              ) => Promise<unknown>;
            }
          ).updateTemplateCard(
            f as unknown as { headers: { req_id: string } },
            {
              card_type: 'text_notice',
              main_title: { title: '已失效', desc: '该操作已过期或不可用' },
              task_id: taskId,
            },
          );
        } catch {}
      }
      {
        const effectiveChatId = body?.chatid ?? body?.from?.userid ?? null;
        if (effectiveChatId) {
          try {
            await ctx.updateChannelRuntime(channelId, {
              configMerge: {
                lastChatid: effectiveChatId,
                lastChattype: body.chattype,
                lastSenderExternalId: body.from?.userid ?? null,
              },
            });
          } catch {}
        }
      }
    };

    (
      client as unknown as {
        on: (ev: string, fn: (...args: unknown[]) => unknown) => unknown;
      }
    ).on('event', async (frame: unknown) => {
      try {
        await handleTemplateCardEvent(frame);
      } catch (e) {
        this.logger.warn(`wecom event handler failed: ${(e as Error).message}`);
      }
    });
    (
      client as unknown as {
        on: (ev: string, fn: (...args: unknown[]) => unknown) => unknown;
      }
    ).on('event.template_card_event', async (frame: unknown) => {
      try {
        await handleTemplateCardEvent(frame);
      } catch (e) {
        this.logger.warn(
          `wecom template_card_event handler failed: ${(e as Error).message}`,
        );
      }
    });

    client.on('connected', async () => {
      try {
        await ctx.updateChannelRuntime(channelId, {
          lastStatus: 'connected',
          lastError: '',
        });
      } catch {}
    });
    client.on('authenticated', async () => {
      this.reconnectCounts.set(channelId, 0);
      try {
        await ctx.updateChannelRuntime(channelId, {
          lastStatus: 'connected',
          lastError: '',
        });
      } catch {}
    });
    client.on('disconnected', async (reason: string) => {
      try {
        await ctx.updateChannelRuntime(channelId, {
          lastStatus: 'disconnected',
          lastError: (reason ?? '').slice(0, 512),
        });
      } catch {}
    });
    client.on('reconnecting', async (attempt: number) => {
      const cur = (this.reconnectCounts.get(channelId) ?? 0) + 1;
      this.reconnectCounts.set(channelId, cur);
      try {
        await ctx.updateChannelRuntime(channelId, {
          lastStatus: 'reconnecting',
          lastError: `attempt ${attempt}`,
        });
      } catch {}
      if (cur > 3) {
        try {
          await ctx.updateChannelRuntime(channelId, {
            lastStatus: 'error',
            lastError: `reconnect failed after ${cur} attempts`,
          });
        } catch {}
      }
    });
    client.on('error', async (err: Error) => {
      try {
        await ctx.updateChannelRuntime(channelId, {
          lastStatus: 'error',
          lastError: (err.message ?? String(err)).slice(0, 512),
        });
      } catch {}
    });
  }

  async stop(): Promise<void> {
    for (const [channelId, client] of this.clients.entries()) {
      try {
        client.disconnect();
      } catch (e) {
        this.logger.warn(
          `wecom disconnect failed channel=${channelId}: ${(e as Error).message}`,
        );
      }
    }
    for (const entry of this.streams.values()) {
      if (entry.spinnerTimer) {
        try { clearInterval(entry.spinnerTimer); } catch {}
      }
    }
    this.clients.clear();
    this.hosts.clear();
    this.streams.clear();
    this.reconnectCounts.clear();
    this.taskPendingOperators.clear();
    this.aqOperatorMap.clear();
  }

  async normalizeInbound(
    _req: unknown,
    _channel: MessageChannelResolved,
  ): Promise<InboundCommand[]> {
    return [];
  }

  /**
   * Send WeCom template_card for agent question/permission.
   * - permission: button_interaction with approve/reject (2 buttons, no truncation)
   * - question: 1-2 options -> button_interaction (max 6, label 10 chars); 3+ options -> vote_interaction checkbox vertical list (label up to 17 chars, avoids 2-char truncation) with submit button
   */

  async sendQuestionCard(
    channel: MessageChannelResolved,
    question: { id: string; requestId?: string; kind: string; content: any },
  ): Promise<{ externalId?: string | null }> {
    const aqId = question.id;
    if (!aqId) throw new Error('missing question id');
    const cfg = (channel.config ?? {}) as Record<string, unknown>;
    const chatId =
      (cfg.lastChatid as string | undefined) ??
      (cfg.lastChatId as string | undefined) ??
      (cfg.lastSenderExternalId as string | undefined) ??
      null;
    if (!chatId) {
      throw new Error(INTEGRATIONS_ERRORS.TASK_NOT_BOUND);
    }
    const client = this.clients.get(channel.id);
    if (!client) {
      throw new Error(`no WSClient for channel ${channel.id}`);
    }
    const kind = question.kind;
    const content: any = question.content ?? {};

    const sendMarkdown = async (text: string) => {
      const res: any = await client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: text },
      } as unknown as Parameters<WSClient['sendMessage']>[1]);
      if (res && typeof res.errcode !== 'undefined' && res.errcode !== 0) {
        throw new Error(res.errmsg ?? `wecom sendMessage failed errcode=${res.errcode}`);
      }
      return { externalId: (res?.headers?.req_id ?? null) as string | null };
    };

    if (kind === 'permission') {
      const title: string =
        typeof content.title === 'string' && content.title.trim().length > 0
          ? content.title.trim()
          : '权限请求';
      const patternRaw =
        typeof content.pattern === 'string'
          ? content.pattern
          : typeof content.type === 'string'
            ? content.type
            : '';
      const pattern = String(patternRaw ?? '').slice(0, 512);
      const card = {
        card_type: 'button_interaction',
        main_title: {
          title: String(title).slice(0, 64),
          desc: pattern || '权限请求待确认',
        },
        sub_title_text: '请确认是否允许',
        button_list: [
          { text: '批准', style: 1, key: `${aqId}:approve` },
          { text: '拒绝', style: 3, key: `${aqId}:reject` },
        ],
        task_id: String(aqId).slice(0, 128),
      };
      const res: any = await client.sendMessage(chatId, {
        msgtype: 'template_card',
        template_card: card,
      } as unknown as Parameters<WSClient['sendMessage']>[1]);
      if (res && typeof res.errcode !== 'undefined' && res.errcode !== 0) {
        throw new Error(res.errmsg ?? `wecom sendMessage failed errcode=${res.errcode}`);
      }
      this.logger.log(`wecom sendQuestionCard permission ok channel=${channel.id} aqId=${aqId} chatId=${chatId}`);
      return { externalId: (res?.headers?.req_id ?? null) as string | null };
    }

    if (kind === 'question') {
      const questions: any[] = Array.isArray(content.questions) ? content.questions : [];
      if (questions.length === 1) {
        const q0 = questions[0] ?? {};
        const qText: string =
          typeof q0.question === 'string'
            ? q0.question
            : typeof q0.header === 'string'
              ? q0.header
              : '';
        const opts: any[] = Array.isArray(q0.options) ? q0.options : [];
        if (opts.length > 0) {
          if (opts.length > 2) {
            const seen = new Set<string>();
            const option_list = opts.slice(0, 20).map((o: any, idx: number) => {
              const labelRaw =
                typeof o === 'string'
                  ? o
                  : typeof o?.label === 'string'
                    ? o.label
                    : String(o ?? '');
              const label = String(labelRaw).trim() || `选项${idx + 1}`;
              let id = `${aqId}:${label}`.slice(0, 128);
              if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
              seen.add(id);
              return { id, text: label.slice(0, 17) || '选项' };
            });
            const card = {
              card_type: 'vote_interaction',
              main_title: {
                title: (qText || '待确认').slice(0, 64),
                desc: qText.slice(0, 512) || '待确认问题',
              },
              checkbox: {
                question_key: String(aqId).slice(0, 1024),
                option_list,
                mode: 0,
              },
              submit_button: { text: '提交', key: `${aqId}:submit`.slice(0, 1024) },
              task_id: String(aqId).slice(0, 128),
            };
            const res: any = await client.sendMessage(chatId, {
              msgtype: 'template_card',
              template_card: card,
            } as unknown as Parameters<WSClient['sendMessage']>[1]);
            if (res && typeof res.errcode !== 'undefined' && res.errcode !== 0) {
              throw new Error(res.errmsg ?? `wecom sendMessage failed errcode=${res.errcode}`);
            }
            this.logger.log(`wecom sendQuestionCard question vote ok channel=${channel.id} aqId=${aqId} chatId=${chatId} options=${option_list.length}`);
            return { externalId: (res?.headers?.req_id ?? null) as string | null };
          }
          const buttons = opts.slice(0, 6).map((o: any) => {
            const labelRaw =
              typeof o === 'string'
                ? o
                : typeof o?.label === 'string'
                  ? o.label
                  : String(o ?? '');
            const label = String(labelRaw).trim() || '选项';
            const text = label.slice(0, 10) || '选项';
            const key = `${aqId}:${label}`.slice(0, 1024);
            return { text, style: 1, key };
          });
          const card = {
            card_type: 'button_interaction',
            main_title: {
              title: (qText || '待确认').slice(0, 64),
              desc: qText.slice(0, 512) || '待确认问题',
            },
            sub_title_text: qText.slice(0, 512) || '请选择',
            button_list: buttons,
            task_id: String(aqId).slice(0, 128),
          };
          const res: any = await client.sendMessage(chatId, {
            msgtype: 'template_card',
            template_card: card,
          } as unknown as Parameters<WSClient['sendMessage']>[1]);
          if (res && typeof res.errcode !== 'undefined' && res.errcode !== 0) {
            throw new Error(res.errmsg ?? `wecom sendMessage failed errcode=${res.errcode}`);
          }
          this.logger.log(`wecom sendQuestionCard question ok channel=${channel.id} aqId=${aqId} chatId=${chatId} options=${buttons.length}`);
          return { externalId: (res?.headers?.req_id ?? null) as string | null };
        }
      }
      const fallback =
        questions.length > 1
          ? `【待确认】${questions.length}个问题待处理，请前往Web处理`
          : `【待确认】${(() => {
              const q0 = questions[0] ?? {};
              const t = (q0.question ?? q0.header ?? JSON.stringify(content)).toString().slice(0, 200);
              return t || '请前往Web处理';
            })()}`;
      this.logger.log(`wecom sendQuestionCard fallback markdown channel=${channel.id} aqId=${aqId} reason=${questions.length > 1 ? 'multi-question' : 'no-options'}`);
      return sendMarkdown(fallback);
    }

    const text = `【待确认】请前往Web处理（kind=${kind}）`;
    return sendMarkdown(text);
  }

  discardStream(internalMessageId: string): boolean {
    const entry = this.streams.get(internalMessageId);
    const had = !!entry;
    if (entry?.spinnerTimer) {
      try { clearInterval(entry.spinnerTimer); } catch {}
      this.logger.log(`wecom spinner cleared on discardStream internalMessageId=${internalMessageId} stream=${entry.streamId}`);
    }
    if (had) this.streams.delete(internalMessageId);
    if (had) this.logger.log(`wecom discardStream post-card: removed placeholder stream internalMessageId=${internalMessageId} without replyStream (placeholder remains spinner, new reply will be sent via sendNewMessage after card)`);
    else this.logger.log(`wecom discardStream miss internalMessageId=${internalMessageId}`);
    return had;
  }

  async sendNewMessage(channelId: string, text: string): Promise<boolean> {
    const client = this.clients.get(channelId);
    if (!client) {
      this.logger.warn(`wecom sendNewMessage no client channelId=${channelId}`);
      return false;
    }
    const host = this.hosts.get(channelId) ?? this.attachedHost;
    let targetChatId: string | null = null;
    if (host?.getChannel) {
      try {
        const ch = await host.getChannel(channelId);
        const cfg = (ch?.config ?? {}) as Record<string, unknown>;
        targetChatId =
          (cfg.lastChatid as string | undefined) ??
          (cfg.lastChatId as string | undefined) ??
          (cfg.lastSenderExternalId as string | undefined) ??
          null;
      } catch {}
    }
    if (!targetChatId) {
      try {
        const raw = this.hosts.get(channelId) as unknown as { prisma?: unknown } | undefined;
        const prismaLike =
          (raw as unknown as { prisma?: unknown })?.prisma ??
          (this.attachedHost as unknown as { prisma?: unknown })?.prisma;
        if (
          prismaLike &&
          typeof (prismaLike as Record<string, unknown>).messageChannel !== 'undefined'
        ) {
          const rows = await (
            (prismaLike as { messageChannel: { findUnique: (q: unknown) => Promise<{ config?: unknown }> } })
              .messageChannel.findUnique as (q: unknown) => Promise<{ config?: unknown }>
          )({ where: { id: channelId }, select: { config: true } });
          const cfg = (rows?.config ?? {}) as Record<string, unknown>;
          targetChatId =
            (cfg.lastChatid as string | undefined) ??
            (cfg.lastChatId as string | undefined) ??
            (cfg.lastSenderExternalId as string | undefined) ??
            null;
        }
      } catch {}
    }
    if (!targetChatId) {
      this.logger.warn(`wecom sendNewMessage no target chatId for channelId=${channelId}`);
      return false;
    }
    try {
      await client.sendMessage(targetChatId, {
        msgtype: 'markdown',
        markdown: { content: text },
      } as unknown as Parameters<WSClient['sendMessage']>[1]);
      this.logger.log(`wecom sendNewMessage ok channelId=${channelId} chatId=${targetChatId} textLen=${text.length}`);
      return true;
    } catch (e) {
      this.logger.error(
        `wecom sendNewMessage failed channelId=${channelId} chatId=${targetChatId}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  async finishStream(
    internalMessageId: string,
    text: string,
  ): Promise<boolean> {
    const ref = this.streams.get(internalMessageId);
    const previewClient = ref ? this.clients.get(ref.channelId) : undefined;
    this.logger.log(
      `wecom finishStream called internalMessageId=${internalMessageId} found=${!!ref} channelId=${ref?.channelId ?? 'null'} streamId=${ref?.streamId ?? 'null'} chattype=${(ref as any)?.chattype ?? 'null'} fromUserId=${(ref as any)?.fromUserId ?? 'null'} textLen=${text?.length ?? 0} clientExists=${!!previewClient}`,
    );
    if (!ref) {
      this.logger.warn(`wecom finishStream miss internalMessageId=${internalMessageId}`);
      return false;
    }
    const hadSpinner = !!ref.spinnerTimer;
    if (ref.spinnerTimer) {
      try { clearInterval(ref.spinnerTimer); } catch {}
      ref.spinnerTimer = null;
      this.logger.log(`wecom spinner cleared on finishStream stream=${ref.streamId} internalMessageId=${internalMessageId} hadSpinner=${hadSpinner}`);
    }
    const client = this.clients.get(ref.channelId);
    if (!client) {
      this.logger.warn(
        `wecom finishStream no client for channelId=${ref.channelId} internalMessageId=${internalMessageId}`,
      );
      this.streams.delete(internalMessageId);
      return false;
    }
    try {
      const headersPayload =
        ref.frameHeaders &&
        typeof ref.frameHeaders === 'object' &&
        'req_id' in (ref.frameHeaders as Record<string, unknown>)
          ? { headers: ref.frameHeaders as unknown as { req_id: string } }
          : ref.frameHeaders &&
              typeof ref.frameHeaders === 'object' &&
              'headers' in (ref.frameHeaders as Record<string, unknown>)
            ? (ref.frameHeaders as unknown as { headers: { req_id: string } })
            : ({ headers: ref.frameHeaders } as unknown as {
                headers: { req_id: string };
              });
      await (
        client as unknown as {
          replyStream: (
            frame: unknown,
            streamId: string,
            content: string,
            finish: boolean,
          ) => Promise<unknown>;
        }
      ).replyStream(headersPayload, ref.streamId, text, true);
      this.logger.log(
        `wecom finishStream ok internalMessageId=${internalMessageId} channelId=${ref.channelId} streamId=${ref.streamId} textLen=${text.length}`,
      );
    } catch (e) {
      this.logger.error(
        `wecom finishStream failed internalMessageId=${internalMessageId} streamId=${ref.streamId}: ${(e as Error).message}`,
        (e as Error).stack,
      );
      this.streams.delete(internalMessageId);
      return false;
    }
    this.streams.delete(internalMessageId);
    return true;
  }

  async sendFallbackMessage(channelId: string, text: string): Promise<boolean> {
    const client = this.clients.get(channelId);
    if (!client) {
      this.logger.warn(`wecom sendFallbackMessage no client channelId=${channelId}`);
      return false;
    }
    const host = this.hosts.get(channelId) ?? this.attachedHost;
    let fallbackChatId: string | null = null;
    if (host?.getChannel) {
      try {
        const ch = await host.getChannel(channelId);
        const cfg = (ch?.config ?? {}) as Record<string, unknown>;
        fallbackChatId =
          (cfg.lastChatid as string | undefined) ??
          (cfg.lastChatId as string | undefined) ??
          (cfg.lastSenderExternalId as string | undefined) ??
          null;
      } catch {}
    }
    if (!fallbackChatId) {
      try {
        const raw = this.hosts.get(channelId) as unknown as { prisma?: unknown } | undefined;
        const prismaLike =
          (raw as unknown as { prisma?: unknown })?.prisma ??
          (this.attachedHost as unknown as { prisma?: unknown })?.prisma;
        if (
          prismaLike &&
          typeof (prismaLike as Record<string, unknown>).messageChannel !== 'undefined'
        ) {
          const rows = await (
            (prismaLike as { messageChannel: { findUnique: (q: unknown) => Promise<{ config?: unknown }> } })
              .messageChannel.findUnique as (q: unknown) => Promise<{ config?: unknown }>
          )({ where: { id: channelId }, select: { config: true } });
          const cfg = (rows?.config ?? {}) as Record<string, unknown>;
          fallbackChatId =
            (cfg.lastChatid as string | undefined) ??
            (cfg.lastChatId as string | undefined) ??
            (cfg.lastSenderExternalId as string | undefined) ??
            null;
        }
      } catch {}
    }
    if (!fallbackChatId) {
      this.logger.warn(`wecom sendFallbackMessage no fallback chatId for channelId=${channelId}`);
      return false;
    }
    try {
      await client.sendMessage(fallbackChatId, {
        msgtype: 'markdown',
        markdown: { content: text },
      } as unknown as Parameters<WSClient['sendMessage']>[1]);
      this.logger.log(`wecom sendFallbackMessage ok channelId=${channelId} chatId=${fallbackChatId} textLen=${text.length}`);
      return true;
    } catch (e) {
      this.logger.error(
        `wecom sendFallbackMessage failed channelId=${channelId} chatId=${fallbackChatId}: ${(e as Error).message}`,
      );
      return false;
    }
  }

  private async resolveChatId(channelId: string): Promise<string | null> {
    const host = this.hosts.get(channelId) ?? this.attachedHost;
    if (host?.getChannel) {
      try {
        const ch = await host.getChannel(channelId);
        const cfg = (ch?.config ?? {}) as Record<string, unknown>;
        const cid =
          (cfg.lastChatid as string | undefined) ??
          (cfg.lastChatId as string | undefined) ??
          (cfg.lastSenderExternalId as string | undefined) ??
          null;
        if (cid) return cid;
      } catch {}
    }
    try {
      const raw = this.hosts.get(channelId) as unknown as { prisma?: unknown } | undefined;
      const prismaLike =
        (raw as unknown as { prisma?: unknown })?.prisma ??
        (this.attachedHost as unknown as { prisma?: unknown })?.prisma;
      if (
        prismaLike &&
        typeof (prismaLike as Record<string, unknown>).messageChannel !== 'undefined'
      ) {
        const rows = await (
          (prismaLike as { messageChannel: { findUnique: (q: unknown) => Promise<{ config?: unknown }> } })
            .messageChannel.findUnique as (q: unknown) => Promise<{ config?: unknown }>
        )({ where: { id: channelId }, select: { config: true } });
        const cfg = (rows?.config ?? {}) as Record<string, unknown>;
        return (
          (cfg.lastChatid as string | undefined) ??
          (cfg.lastChatId as string | undefined) ??
          (cfg.lastSenderExternalId as string | undefined) ??
          null
        );
      }
    } catch {}
    return null;
  }

  async sendTemplateCard(channelId: string, card: unknown): Promise<boolean> {
    const client = this.clients.get(channelId);
    if (!client) {
      this.logger.warn(`wecom sendTemplateCard no client channelId=${channelId} card=${JSON.stringify(card).slice(0, 800)}`);
      return false;
    }
    const chatId = await this.resolveChatId(channelId);
    if (!chatId) {
      this.logger.warn(`wecom sendTemplateCard no chatId channelId=${channelId} card=${JSON.stringify(card).slice(0, 1200)}`);
      return false;
    }
    const cardObj: any = card as any;
    if (!cardObj || typeof cardObj !== 'object' || !cardObj.card_type) {
      this.logger.warn(`wecom sendTemplateCard invalid card missing card_type channelId=${channelId} chatId=${chatId} card=${JSON.stringify(card).slice(0, 1200)}`);
      return false;
    }
    if ('card_style' in cardObj) delete cardObj.card_style;
    if (!cardObj.source || typeof cardObj.source !== 'object') cardObj.source = { desc: 'vteam', desc_color: 0 };
    else if (typeof (cardObj.source as any).desc_color !== 'undefined' && ![0, 1, 2, 3].includes((cardObj.source as any).desc_color)) (cardObj.source as any).desc_color = 0;
    const _placeholder = 'https://work.weixin.qq.com';
    const _isNoticeSend = cardObj.card_type === 'text_notice' || cardObj.card_type === 'news_notice';
    const _isInteractiveSend = ['button_interaction', 'vote_interaction', 'multiple_interaction'].includes(cardObj.card_type);
    if (_isNoticeSend) {
      const ca: any = cardObj.card_action;
      const ok1 = ca && typeof ca === 'object' && ca.type === 1 && ca.url && String(ca.url).trim();
      const ok2 = ca && typeof ca === 'object' && ca.type === 2 && ca.appid && String(ca.appid).trim();
      if (!ok1 && !ok2) cardObj.card_action = { type: 1, url: _placeholder };
      else if (ca.type === 1 && !ca.url) ca.url = _placeholder;
    } else if (_isInteractiveSend) {
      if (cardObj.card_action && typeof cardObj.card_action === 'object') {
        const ca: any = cardObj.card_action;
        if (![0, 1, 2].includes(ca.type)) delete cardObj.card_action;
        else if (ca.type === 1 && (!ca.url || !String(ca.url).trim())) ca.url = _placeholder;
        else if (ca.type === 2 && (!ca.appid || !String(ca.appid).trim())) delete cardObj.card_action;
      }
    } else {
      if (cardObj.card_action && typeof cardObj.card_action === 'object') {
        const ca: any = cardObj.card_action;
        if (![0, 1, 2].includes(ca.type)) delete cardObj.card_action;
        else if (ca.type === 1 && !ca.url) ca.url = _placeholder;
        else if (ca.type === 2 && !ca.appid) delete cardObj.card_action;
      }
    }
    if (Array.isArray(cardObj.button_list)) {
      for (let i = 0; i < cardObj.button_list.length; i++) {
        const btn: any = cardObj.button_list[i];
        if (!btn || typeof btn !== 'object') continue;
        if (!btn.key || !String(btn.key).trim()) btn.key = `btn_${i}_${Date.now()}`.slice(0, 1024);
        if (typeof btn.style !== 'undefined' && ![1, 2, 3, 4].includes(btn.style)) btn.style = 1;
        if (btn.type === 1 && (!btn.url || !String(btn.url).trim())) btn.url = _placeholder;
        if (typeof btn.type !== 'undefined' && ![0, 1, 2].includes(btn.type)) { delete btn.type; if (btn.url) delete btn.url; if (btn.appid) delete btn.appid; }
        if (btn.type === 2 && (!btn.appid || !String(btn.appid).trim())) { delete btn.type; delete btn.appid; if (btn.pagepath) delete btn.pagepath; }
      }
    }
    if (cardObj.card_type === 'news_notice') {
      const ci: any = cardObj.card_image;
      if (!ci || typeof ci !== 'object' || !ci.url || !String(ci.url).trim()) {
        cardObj.card_image = { url: _placeholder };
      } else if (!/^https?:\/\//.test(String(ci.url).trim())) {
        ci.url = _placeholder;
      }
      if (!cardObj.image_text_area || typeof cardObj.image_text_area !== 'object') {
        const t = (cardObj.main_title as any)?.title ?? '图文消息';
        const d = (cardObj.main_title as any)?.desc ?? '';
        cardObj.image_text_area = { type: 1, title: String(t).slice(0, 64), desc: String(d).slice(0, 512), url: _placeholder, image_url: _placeholder };
      }
    }
    if (cardObj.card_type === 'vote_interaction') {
      const cb: any = cardObj.checkbox;
      let optionList: any[] | null = null;
      if (cb && typeof cb === 'object' && Array.isArray(cb.option_list) && cb.option_list.length > 0) optionList = cb.option_list;
      if (!optionList || optionList.length === 0) {
        const raw: any = (cardObj as any).vote_list ?? (cardObj as any).option_list ?? (cardObj as any).options ?? (cardObj as any).select_list?.option_list ?? (cardObj as any).select_list;
        if (Array.isArray(raw) && raw.length > 0) optionList = raw;
        else if (raw && typeof raw === 'object' && Array.isArray((raw as any).option_list)) optionList = (raw as any).option_list;
      }
      if (optionList && optionList.length > 0) {
        const seen = new Set<string>();
        const qkRaw = cb?.question_key ?? (cardObj as any).vote_title ?? cardObj.main_title?.title ?? String(cardObj.task_id ?? 'q');
        const qk = String(qkRaw).slice(0, 1024) || 'q';
        const titleRaw = (cardObj as any).vote_title ?? cb?.title ?? '';
        const mapped = optionList.slice(0, 20).map((o: any, idx: number) => {
          if (typeof o === 'string') {
            const text = o.trim().slice(0, 17) || `选项${idx + 1}`;
            let id = `${qk}:${text}`.slice(0, 128);
            if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
            seen.add(id);
            return { id, text };
          }
          const textRaw = o.text ?? o.label ?? o.title ?? String(o.id ?? '');
          const text = String(textRaw).trim().slice(0, 17) || `选项${idx + 1}`;
          let id = String(o.id ?? o.key ?? `${qk}:${text}`).slice(0, 128);
          if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
          seen.add(id);
          const it: any = { id, text };
          if (typeof o.is_checked === 'boolean') it.is_checked = o.is_checked;
          return it;
        });
        while (mapped.length < 2) {
          const idx = mapped.length;
          const text = `选项${idx + 1}`;
          const id = `${qk}:${text}_${idx}`.slice(0, 128);
          mapped.push({ id, text });
        }
        cardObj.checkbox = { question_key: qk, title: String(titleRaw).slice(0, 64) || undefined, option_list: mapped, mode: typeof cb?.mode === 'number' ? cb.mode : 0 };
        if (!cardObj.checkbox.title) delete cardObj.checkbox.title;
        if ('vote_list' in cardObj) delete (cardObj as any).vote_list;
        if ('vote_title' in cardObj) delete (cardObj as any).vote_title;
        if ('select_list' in cardObj) delete (cardObj as any).select_list;
        if (!cardObj.submit_button || typeof cardObj.submit_button !== 'object') {
          cardObj.submit_button = { text: '提交', key: `${qk}:submit`.slice(0, 1024) };
        } else {
          if (!(cardObj.submit_button as any).key) (cardObj.submit_button as any).key = `${qk}:submit`.slice(0, 1024);
          if (!(cardObj.submit_button as any).text) (cardObj.submit_button as any).text = '提交';
        }
      } else if (!cb || !Array.isArray(cb.option_list) || cb.option_list.length < 2) {
        const qk = String((cardObj as any).vote_title ?? cardObj.main_title?.title ?? String(cardObj.task_id ?? 'q')).slice(0, 1024);
        const mapped = [{ id: `${qk}:选项1`.slice(0, 128), text: '选项1' }, { id: `${qk}:选项2`.slice(0, 128), text: '选项2' }];
        cardObj.checkbox = { question_key: qk, option_list: mapped, mode: 0 };
        cardObj.submit_button = { text: '提交', key: `${qk}:submit`.slice(0, 1024) };
        if ('vote_list' in cardObj) delete (cardObj as any).vote_list;
        if ('vote_title' in cardObj) delete (cardObj as any).vote_title;
      }
    }
    this.logger.log(`wecom sendTemplateCard try channelId=${channelId} chatId=${chatId} card_type=${cardObj.card_type} task_id=${cardObj.task_id ?? ''} card=${JSON.stringify(cardObj).slice(0, 2000)}`);
    try {
      const res: any = await client.sendMessage(chatId, {
        msgtype: 'template_card',
        template_card: cardObj,
      } as unknown as Parameters<WSClient['sendMessage']>[1]);
      const rc = res?.errcode ?? res?.errCode;
      if (typeof rc !== 'undefined' && rc !== 0) {
        this.logger.warn(`wecom sendTemplateCard non-zero errcode channelId=${channelId} chatId=${chatId} card_type=${cardObj.card_type} res=${JSON.stringify(res).slice(0, 1200)}`);
        return false;
      }
      this.logger.log(`wecom sendTemplateCard ok channelId=${channelId} chatId=${chatId} card_type=${cardObj.card_type} res=${JSON.stringify(res ?? {}).slice(0, 500)}`);
      return true;
    } catch (e) {
      const ee: any = e as any;
      const detail = ee?.errcode ?? ee?.errCode ?? ee?.errmsg ?? ee?.message ?? String(e);
      const raw = (() => { try { return JSON.stringify(e).slice(0, 1200); } catch { return String(e).slice(0, 800); } })();
      this.logger.error(`wecom sendTemplateCard failed channelId=${channelId} chatId=${chatId} card_type=${(card as any)?.card_type ?? 'unknown'} card=${JSON.stringify(cardObj).slice(0, 1200)} err=${detail} raw=${raw} stack=${(e as Error).stack?.slice(0, 800) ?? ''}`);
      return false;
    }
  }

  async replyTemplateCard(internalMessageId: string, card: unknown): Promise<boolean> {
    const ref = this.streams.get(internalMessageId);
    if (!ref) {
      this.logger.warn(`wecom replyTemplateCard miss no stream internalMessageId=${internalMessageId} card=${JSON.stringify(card).slice(0, 800)}`);
      return false;
    }
    if (ref.spinnerTimer) {
      try { clearInterval(ref.spinnerTimer); } catch {}
      ref.spinnerTimer = null;
    }
    const client = this.clients.get(ref.channelId);
    if (!client) {
      this.logger.warn(`wecom replyTemplateCard no client channelId=${ref.channelId} internalMessageId=${internalMessageId}`);
      this.streams.delete(internalMessageId);
      return false;
    }
    const cardObj: any = card as any;
    if (!cardObj || typeof cardObj !== 'object' || !cardObj.card_type) {
      this.logger.warn(`wecom replyTemplateCard invalid card missing card_type internalMessageId=${internalMessageId} card=${JSON.stringify(card).slice(0, 1200)}`);
      this.streams.delete(internalMessageId);
      return false;
    }
    if ('card_style' in cardObj) delete cardObj.card_style;
    if (!cardObj.source || typeof cardObj.source !== 'object') cardObj.source = { desc: 'vteam', desc_color: 0 };
    else if (typeof (cardObj.source as any).desc_color !== 'undefined' && ![0, 1, 2, 3].includes((cardObj.source as any).desc_color)) (cardObj.source as any).desc_color = 0;
    const _ph2 = 'https://work.weixin.qq.com';
    const _isNoticeReply = cardObj.card_type === 'text_notice' || cardObj.card_type === 'news_notice';
    const _isInteractiveReply = ['button_interaction', 'vote_interaction', 'multiple_interaction'].includes(cardObj.card_type);
    if (_isNoticeReply) {
      const ca: any = cardObj.card_action;
      const ok1 = ca && typeof ca === 'object' && ca.type === 1 && ca.url && String(ca.url).trim();
      const ok2 = ca && typeof ca === 'object' && ca.type === 2 && ca.appid && String(ca.appid).trim();
      if (!ok1 && !ok2) cardObj.card_action = { type: 1, url: _ph2 };
      else if (ca.type === 1 && !ca.url) ca.url = _ph2;
    } else if (_isInteractiveReply) {
      if (cardObj.card_action && typeof cardObj.card_action === 'object') {
        const ca: any = cardObj.card_action;
        if (![0, 1, 2].includes(ca.type)) delete cardObj.card_action;
        else if (ca.type === 1 && (!ca.url || !String(ca.url).trim())) ca.url = _ph2;
        else if (ca.type === 2 && (!ca.appid || !String(ca.appid).trim())) delete cardObj.card_action;
      }
    } else {
      if (cardObj.card_action && typeof cardObj.card_action === 'object') {
        const ca: any = cardObj.card_action;
        if (![0, 1, 2].includes(ca.type)) delete cardObj.card_action;
        else if (ca.type === 1 && !ca.url) ca.url = _ph2;
        else if (ca.type === 2 && !ca.appid) delete cardObj.card_action;
      }
    }
    if (Array.isArray(cardObj.button_list)) {
      for (let i = 0; i < cardObj.button_list.length; i++) {
        const btn: any = cardObj.button_list[i];
        if (!btn || typeof btn !== 'object') continue;
        if (!btn.key || !String(btn.key).trim()) btn.key = `btn_${i}_${Date.now()}`.slice(0, 1024);
        if (typeof btn.style !== 'undefined' && ![1, 2, 3, 4].includes(btn.style)) btn.style = 1;
        if (btn.type === 1 && (!btn.url || !String(btn.url).trim())) btn.url = _ph2;
        if (typeof btn.type !== 'undefined' && ![0, 1, 2].includes(btn.type)) { delete btn.type; if (btn.url) delete btn.url; if (btn.appid) delete btn.appid; }
        if (btn.type === 2 && (!btn.appid || !String(btn.appid).trim())) { delete btn.type; delete btn.appid; if (btn.pagepath) delete btn.pagepath; }
      }
    }
    if (cardObj.card_type === 'news_notice') {
      const ci: any = cardObj.card_image;
      if (!ci || typeof ci !== 'object' || !ci.url || !String(ci.url).trim()) {
        cardObj.card_image = { url: _ph2 };
      } else if (!/^https?:\/\//.test(String(ci.url).trim())) {
        ci.url = _ph2;
      }
      if (!cardObj.image_text_area || typeof cardObj.image_text_area !== 'object') {
        const t = (cardObj.main_title as any)?.title ?? '图文消息';
        const d = (cardObj.main_title as any)?.desc ?? '';
        cardObj.image_text_area = { type: 1, title: String(t).slice(0, 64), desc: String(d).slice(0, 512), url: _ph2, image_url: _ph2 };
      }
    }
    if (cardObj.card_type === 'vote_interaction') {
      const cb: any = cardObj.checkbox;
      let optionList: any[] | null = null;
      if (cb && typeof cb === 'object' && Array.isArray(cb.option_list) && cb.option_list.length > 0) optionList = cb.option_list;
      if (!optionList || optionList.length === 0) {
        const raw: any = (cardObj as any).vote_list ?? (cardObj as any).option_list ?? (cardObj as any).options ?? (cardObj as any).select_list?.option_list ?? (cardObj as any).select_list;
        if (Array.isArray(raw) && raw.length > 0) optionList = raw;
        else if (raw && typeof raw === 'object' && Array.isArray((raw as any).option_list)) optionList = (raw as any).option_list;
      }
      if (optionList && optionList.length > 0) {
        const seen = new Set<string>();
        const qkRaw = cb?.question_key ?? (cardObj as any).vote_title ?? cardObj.main_title?.title ?? String(cardObj.task_id ?? 'q');
        const qk = String(qkRaw).slice(0, 1024) || 'q';
        const titleRaw = (cardObj as any).vote_title ?? cb?.title ?? '';
        const mapped = optionList.slice(0, 20).map((o: any, idx: number) => {
          if (typeof o === 'string') {
            const text = o.trim().slice(0, 17) || `选项${idx + 1}`;
            let id = `${qk}:${text}`.slice(0, 128);
            if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
            seen.add(id);
            return { id, text };
          }
          const textRaw = o.text ?? o.label ?? o.title ?? String(o.id ?? '');
          const text = String(textRaw).trim().slice(0, 17) || `选项${idx + 1}`;
          let id = String(o.id ?? o.key ?? `${qk}:${text}`).slice(0, 128);
          if (seen.has(id)) id = `${id}_${idx}`.slice(0, 128);
          seen.add(id);
          const it: any = { id, text };
          if (typeof o.is_checked === 'boolean') it.is_checked = o.is_checked;
          return it;
        });
        while (mapped.length < 2) {
          const idx = mapped.length;
          const text = `选项${idx + 1}`;
          const id = `${qk}:${text}_${idx}`.slice(0, 128);
          mapped.push({ id, text });
        }
        cardObj.checkbox = { question_key: qk, title: String(titleRaw).slice(0, 64) || undefined, option_list: mapped, mode: typeof cb?.mode === 'number' ? cb.mode : 0 };
        if (!cardObj.checkbox.title) delete cardObj.checkbox.title;
        if ('vote_list' in cardObj) delete (cardObj as any).vote_list;
        if ('vote_title' in cardObj) delete (cardObj as any).vote_title;
        if ('select_list' in cardObj) delete (cardObj as any).select_list;
        if (!cardObj.submit_button || typeof cardObj.submit_button !== 'object') {
          cardObj.submit_button = { text: '提交', key: `${qk}:submit`.slice(0, 1024) };
        } else {
          if (!(cardObj.submit_button as any).key) (cardObj.submit_button as any).key = `${qk}:submit`.slice(0, 1024);
          if (!(cardObj.submit_button as any).text) (cardObj.submit_button as any).text = '提交';
        }
      } else if (!cb || !Array.isArray(cb.option_list) || cb.option_list.length < 2) {
        const qk = String((cardObj as any).vote_title ?? cardObj.main_title?.title ?? String(cardObj.task_id ?? 'q')).slice(0, 1024);
        const mapped = [{ id: `${qk}:选项1`.slice(0, 128), text: '选项1' }, { id: `${qk}:选项2`.slice(0, 128), text: '选项2' }];
        cardObj.checkbox = { question_key: qk, option_list: mapped, mode: 0 };
        cardObj.submit_button = { text: '提交', key: `${qk}:submit`.slice(0, 1024) };
        if ('vote_list' in cardObj) delete (cardObj as any).vote_list;
        if ('vote_title' in cardObj) delete (cardObj as any).vote_title;
      }
    }
    this.logger.log(`wecom replyTemplateCard try internalMessageId=${internalMessageId} channelId=${ref.channelId} stream=${ref.streamId} card_type=${cardObj.card_type} task_id=${cardObj.task_id ?? ''} card=${JSON.stringify(cardObj).slice(0, 2000)}`);
    try {
      const headersPayload =
        ref.frameHeaders && typeof ref.frameHeaders === 'object' && 'req_id' in (ref.frameHeaders as Record<string, unknown>)
          ? { headers: ref.frameHeaders as unknown as { req_id: string } }
          : ref.frameHeaders && typeof ref.frameHeaders === 'object' && 'headers' in (ref.frameHeaders as Record<string, unknown>)
            ? (ref.frameHeaders as unknown as { headers: { req_id: string } })
            : ({ headers: ref.frameHeaders } as unknown as { headers: { req_id: string } });
      const res: any = await (client as unknown as { replyTemplateCard: (f: unknown, c: unknown) => Promise<unknown> }).replyTemplateCard(headersPayload, cardObj as any);
      const rc = res?.errcode ?? res?.errCode;
      if (typeof rc !== 'undefined' && rc !== 0) {
        this.logger.warn(`wecom replyTemplateCard non-zero errcode internalMessageId=${internalMessageId} card_type=${cardObj.card_type} res=${JSON.stringify(res).slice(0, 1200)}`);
        this.streams.delete(internalMessageId);
        return false;
      }
      this.logger.log(`wecom replyTemplateCard ok internalMessageId=${internalMessageId} stream=${ref.streamId} card_type=${cardObj.card_type} res=${JSON.stringify(res ?? {}).slice(0, 500)}`);
      this.streams.delete(internalMessageId);
      return true;
    } catch (e) {
      const ee: any = e as any;
      const detail = ee?.errcode ?? ee?.errCode ?? ee?.errmsg ?? ee?.message ?? String(e);
      const raw = (() => { try { return JSON.stringify(e).slice(0, 1200); } catch { return String(e).slice(0, 800); } })();
      this.logger.warn(`wecom replyTemplateCard failed internalMessageId=${internalMessageId} stream=${ref.streamId} card_type=${cardObj.card_type} card=${JSON.stringify(cardObj).slice(0, 1200)} err=${detail} raw=${raw} stack=${(e as Error).stack?.slice(0, 600) ?? ''}`);
      this.streams.delete(internalMessageId);
      return false;
    }
  }

  async uploadMediaBuffer(buffer: Buffer, mediaType: 'image' | 'file' | 'voice' | 'video', filename: string): Promise<string | null> {
    const client = this.clients.values().next().value as WSClient | undefined;
    if (!client) {
      this.logger.warn('wecom uploadMediaBuffer no client available');
      return null;
    }
    try {
      const res: any = await client.uploadMedia(buffer, { type: mediaType, filename });
      this.logger.log(`wecom uploadMedia ok type=${mediaType} filename=${filename} media_id=${res?.media_id}`);
      return res?.media_id ?? null;
    } catch (e) {
      this.logger.error(`wecom uploadMedia failed type=${mediaType} filename=${filename}: ${(e as Error).message}`);
      return null;
    }
  }

  async sendMediaMessage(channelId: string, mediaType: 'image' | 'file' | 'voice' | 'video', mediaId: string): Promise<boolean> {
    const client = this.clients.get(channelId);
    if (!client) {
      this.logger.warn(`wecom sendMediaMessage no client channelId=${channelId}`);
      return false;
    }
    const chatId = await this.resolveChatId(channelId);
    if (!chatId) {
      this.logger.warn(`wecom sendMediaMessage no chatId channelId=${channelId}`);
      return false;
    }
    try {
      await client.sendMediaMessage(chatId, mediaType as any, mediaId);
      this.logger.log(`wecom sendMediaMessage ok channelId=${channelId} chatId=${chatId} type=${mediaType} mediaId=${mediaId}`);
      return true;
    } catch (e) {
      this.logger.error(`wecom sendMediaMessage failed channelId=${channelId}: ${(e as Error).message}`);
      return false;
    }
  }

  async replyMedia(internalMessageId: string, mediaType: 'image' | 'file' | 'voice' | 'video', mediaId: string): Promise<boolean> {
    const ref = this.streams.get(internalMessageId);
    if (!ref) return false;
    if (ref.spinnerTimer) {
      try { clearInterval(ref.spinnerTimer); } catch {}
      ref.spinnerTimer = null;
    }
    const client = this.clients.get(ref.channelId);
    if (!client) {
      this.streams.delete(internalMessageId);
      return false;
    }
    try {
      const headersPayload =
        ref.frameHeaders && typeof ref.frameHeaders === 'object' && 'req_id' in (ref.frameHeaders as Record<string, unknown>)
          ? { headers: ref.frameHeaders as unknown as { req_id: string } }
          : ref.frameHeaders && typeof ref.frameHeaders === 'object' && 'headers' in (ref.frameHeaders as Record<string, unknown>)
            ? (ref.frameHeaders as unknown as { headers: { req_id: string } })
            : ({ headers: ref.frameHeaders } as unknown as { headers: { req_id: string } });
      await (client as unknown as { replyMedia: (f: unknown, t: string, id: string) => Promise<unknown> }).replyMedia(headersPayload, mediaType, mediaId);
      this.logger.log(`wecom replyMedia ok internalMessageId=${internalMessageId} type=${mediaType} mediaId=${mediaId}`);
      this.streams.delete(internalMessageId);
      return true;
    } catch (e) {
      this.logger.warn(`wecom replyMedia failed internalMessageId=${internalMessageId}: ${(e as Error).message}`);
      this.streams.delete(internalMessageId);
      return false;
    }
  }
}
