import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../chat/chat.service';
import { QuestionsService } from '../questions/questions.service';
import { MessageDeliveryService } from './message-delivery.service';
import { MessageRegistryService } from './message-registry.service';
import {
  MessageHost,
  MessageChannelResolved,
  InboundCommand,
} from './message-adapter';
import {
  AGENT_QUESTION_KINDS,
  AGENT_QUESTION_STATUS,
  QUESTION_PENDING_TTL_MS,
} from '../questions/questions.constants';
import { SENDER_TYPE, CHANNEL_TYPE } from '../common/constants/event.constants';
import {
  DELIVERY_DIRECTIONS,
  DELIVERY_STATUS,
} from './message-channel.constants';

@Injectable()
export class MessageInboundService implements MessageHost {
  private readonly logger = new Logger(MessageInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: MessageDeliveryService,
    @Optional()
    private readonly chatService?: ChatService,
    @Optional()
    private readonly questionsService?: QuestionsService,
    @Optional()
    @Inject(MessageRegistryService)
    private readonly registry?: MessageRegistryService,
  ) {
    if (
      this.registry &&
      typeof (this.registry as unknown as { bindInboundDelegate?: unknown })
        .bindInboundDelegate === 'function'
    ) {
      (
        this.registry as unknown as {
          bindInboundDelegate: (
            fn: (
              c: string,
              cmds: InboundCommand[],
            ) => Promise<{
              results: Array<{ ok: boolean; internalMessageId?: string }>;
            }>,
          ) => void;
        }
      ).bindInboundDelegate(this.submitInbound.bind(this));
    }
  }

  async getChannel(id: string): Promise<MessageChannelResolved | null> {
    const row = await (this.prisma as any).messageChannel.findUnique({
      where: { id },
    });
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      config: (row.config as Record<string, any>) ?? {},
      secrets: (row.secrets as Record<string, any>) ?? {},
      enabled: row.enabled,
      lastStatus: row.lastStatus ?? null,
      lastError: row.lastError ?? null,
    };
  }

  async updateChannelRuntime(
    id: string,
    patch: {
      lastStatus?: string;
      lastError?: string;
      configMerge?: Record<string, any>;
    },
  ): Promise<void> {
    if (
      this.registry &&
      typeof this.registry.updateChannelRuntime === 'function'
    ) {
      return this.registry.updateChannelRuntime(id, patch);
    }
    const data: Record<string, any> = {};
    if (patch.lastStatus !== undefined) data.lastStatus = patch.lastStatus;
    if (patch.lastError !== undefined) data.lastError = patch.lastError;
    if (patch.configMerge !== undefined) {
      const existing = await (this.prisma as any).messageChannel.findUnique({
        where: { id },
        select: { config: true },
      });
      const base = (existing?.config as Record<string, any>) ?? {};
      data.config = { ...base, ...patch.configMerge };
    }
    if (Object.keys(data).length === 0) return;
    await (this.prisma as any).messageChannel.update({
      where: { id },
      data,
    });
  }

  async requestStop(channelId: string): Promise<void> {
    if (this.registry && typeof this.registry.requestStop === 'function') {
      return this.registry.requestStop(channelId);
    }
    const ch = await this.getChannel(channelId);
    if (!ch) return;
  }

  registerStreamCorrelation?(
    internalMessageId: string,
    ref: { channelId: string; frameHeaders: unknown; streamId: string },
  ): void {
    this.logger.log(
      `registerStreamCorrelation internalMessageId=${internalMessageId} streamId=${ref.streamId} channelId=${ref.channelId}`,
    );
    if (
      this.registry &&
      typeof (
        this.registry as unknown as { registerStreamCorrelation?: unknown }
      ).registerStreamCorrelation === 'function'
    ) {
      try {
        (
          this.registry as unknown as {
            registerStreamCorrelation: (a: string, b: unknown) => void;
          }
        ).registerStreamCorrelation(internalMessageId, ref);
      } catch {}
    }
    const adapterFromRegistry = this.registry?.get?.('wecom_aibot') as unknown as
      | { registerStreamCorrelation?: (a: string, b: unknown) => void }
      | undefined;
    if (
      adapterFromRegistry &&
      typeof adapterFromRegistry.registerStreamCorrelation === 'function'
    ) {
      try {
        adapterFromRegistry.registerStreamCorrelation(internalMessageId, ref);
      } catch {}
    }
    const adapterByChannel = this.registry?.get?.(ref.channelId) as unknown as
      | { registerStreamCorrelation?: (a: string, b: unknown) => void }
      | undefined;
    if (
      adapterByChannel &&
      adapterByChannel !== adapterFromRegistry &&
      typeof adapterByChannel.registerStreamCorrelation === 'function'
    ) {
      try {
        adapterByChannel.registerStreamCorrelation(internalMessageId, ref);
      } catch {}
    }
  }

  async submitInbound(
    channelId: string,
    commands: InboundCommand[],
  ): Promise<{ results: Array<{ ok: boolean; internalMessageId?: string }> }> {
    const results: Array<{ ok: boolean; internalMessageId?: string }> = [];
    for (const cmd of commands) {
      const channelRow = await (this.prisma as any).messageChannel.findUnique({
        where: { id: channelId },
      });
      if (!channelRow || !channelRow.enabled) {
        await this.delivery.log(
          DELIVERY_DIRECTIONS.inbound,
          (cmd as any).kind ?? null,
          DELIVERY_STATUS.skipped,
          {
            channelId,
            externalId:
              (cmd as { dedupKey?: string }).dedupKey ??
              (cmd as { senderExternalId?: string }).senderExternalId ??
              null,
            error: !channelRow ? 'channel not found' : 'channel disabled',
            payload: cmd as unknown,
          },
        );
        try {
          await this.requestStop(channelId);
        } catch {}
        results.push({ ok: false });
        continue;
      }

      // Resolve bound tasks via join table — do NOT read MessageChannel.taskId
      let taskLinks: Array<{ taskId: string }> = [];
      try {
        taskLinks = await (this.prisma as any).taskMessageChannel.findMany({
          where: { messageChannelId: channelRow.id },
          select: { taskId: true },
        });
      } catch {
        taskLinks = [];
      }

      if (taskLinks.length === 0) {
        await this.delivery.log(
          DELIVERY_DIRECTIONS.inbound,
          (cmd as any).kind ?? null,
          DELIVERY_STATUS.skipped,
          {
            channelId,
            externalId:
              (cmd as { dedupKey?: string }).dedupKey ??
              (cmd as { senderExternalId?: string }).senderExternalId ??
              null,
            error: 'no tasks bound',
            payload: cmd as unknown,
          },
        );
        results.push({ ok: false });
        continue;
      }

      const boundTaskIds = taskLinks.map((l) => l.taskId);

      if (cmd.kind === 'post_message') {
        let anyOk = false;
        let lastInternalId: string | undefined;

        for (const taskId of boundTaskIds) {
          const groupChannel = await (this.prisma as any).chatChannel.findFirst(
            {
              where: { taskId, type: CHANNEL_TYPE.task_group },
            },
          );
          if (!groupChannel) {
            await this.delivery.log(
              DELIVERY_DIRECTIONS.inbound,
              'post_message',
              DELIVERY_STATUS.rejected,
              {
                channelId,
                externalId:
                  (cmd as { dedupKey?: string }).dedupKey ??
                  (cmd as { senderExternalId?: string }).senderExternalId ??
                  null,
                error: 'task_group channel not found',
                payload: cmd as unknown,
              },
            );
            continue;
          }

          const rawDedup =
            (cmd as { dedupKey?: string }).dedupKey ??
            (cmd as { senderExternalId?: string }).senderExternalId ??
            null;
          const dedupKey = rawDedup ? `${rawDedup}_${taskId}` : null;

          let ingressId: string | undefined;
          if (dedupKey) {
            const r = await this.delivery.tryBeginIngest(channelId, dedupKey);
            if (r.duplicate) {
              await this.delivery.log(
                DELIVERY_DIRECTIONS.inbound,
                'post_message',
                DELIVERY_STATUS.skipped,
                {
                  channelId,
                  externalId: dedupKey,
                  error: 'duplicate',
                  payload: cmd as unknown,
                },
              );
              continue;
            }
            ingressId = r.id;
          }

          if (!this.chatService) {
            await this.delivery.log(
              DELIVERY_DIRECTIONS.inbound,
              'post_message',
              DELIVERY_STATUS.failed,
              {
                channelId,
                externalId: dedupKey,
                error: 'chatService not available',
                payload: cmd as unknown,
              },
            );
            continue;
          }

          try {
            const cmdAny = cmd as any;
            const wecomUserId: string | undefined =
              cmdAny.wecomUserId ?? cmdAny.senderExternalId;
            const wecomUserName: string | undefined =
              cmdAny.wecomUserName ?? cmdAny.senderName;
            const chattype: string | undefined = cmdAny.chattype;
            const displayLabel = wecomUserName || wecomUserId || '';
            const rawText: string = String(cmdAny.text ?? '');
            const inboundText = displayLabel
              ? `[WeCom:${displayLabel}] ${rawText}`
              : rawText;
            const wecomMeta = wecomUserId
              ? {
                  wecomUserId,
                  wecomUserName: wecomUserName ?? wecomUserId,
                  chattype: chattype ?? null,
                }
              : null;
            const res = await this.chatService.createMessage(
              groupChannel.id,
              '__external__',
              { text: inboundText } as any,
              { senderType: SENDER_TYPE.external, senderId: null },
            );
            const internalMessageId = (res as { message?: { id?: string } })
              ?.message?.id;
            if (ingressId) {
              await this.delivery.finish(
                ingressId,
                DELIVERY_STATUS.ok,
                null,
                cmd as unknown,
                { internalMessageId, ...wecomMeta } as unknown,
              );
            } else {
              await this.delivery.log(
                DELIVERY_DIRECTIONS.inbound,
                'post_message',
                DELIVERY_STATUS.ok,
                {
                  channelId,
                  externalId: dedupKey,
                  payload: cmd as unknown,
                  meta: {
                    internalMessageId,
                    ...wecomMeta,
                  } as unknown,
                },
              );
            }

            anyOk = true;
            if (internalMessageId) lastInternalId = internalMessageId;
          } catch (e) {
            const errMsg = (e as Error).message ?? String(e);
            if (ingressId) {
              await this.delivery.finish(
                ingressId,
                DELIVERY_STATUS.failed,
                errMsg,
                cmd as unknown,
                null,
              );
            } else {
              await this.delivery.log(
                DELIVERY_DIRECTIONS.inbound,
                'post_message',
                DELIVERY_STATUS.failed,
                {
                  channelId,
                  externalId: dedupKey,
                  error: errMsg,
                  payload: cmd as unknown,
                },
              );
            }
          }
        }

        if (anyOk) {
          results.push({ ok: true, internalMessageId: lastInternalId });
        } else {
          // If no task succeeded, result is false (already logged per-task)
          // Avoid double-log; results length already one per command.
          results.push({ ok: false });
        }
        continue;
      }

      if (cmd.kind === 'card_action') {
        const aqId = (cmd as any).aqId;
        const action = (cmd as any).action;
        // Helper to forward selection to task_group chat so model sees it
        const forwardSelectionToChat = async (
          taskIdForChat: string | null | undefined,
          opIdForChat: string | undefined,
          opNameForChat: string,
        ) => {
          if (!taskIdForChat || !this.chatService) return;
          try {
            const groupChannel = await (this.prisma as any).chatChannel.findFirst({
              where: { taskId: taskIdForChat, type: CHANNEL_TYPE.task_group },
            });
            if (!groupChannel) {
              this.logger.warn(`card_action forward miss task_group taskId=${taskIdForChat}`);
              return;
            }
            const display = opNameForChat || opIdForChat || '用户';
            // Format mirrors expectation: "GuoLong 选择了: 能, 选项ID:1" plus button key for debugging
            const chatText = `[WeCom:${display}] 选择了: ${action} (选项ID:${action} aqId:${aqId} 按钮Key:${aqId}:${action} 操作者:${opIdForChat ?? display})`;
            await this.chatService.createMessage(
              groupChannel.id,
              '__external__',
              { text: chatText } as any,
              { senderType: SENDER_TYPE.external, senderId: null },
            );
            this.logger.log(`card_action forwarded to chat channel=${groupChannel.id} taskId=${taskIdForChat} text=${chatText.slice(0, 200)}`);
          } catch (e) {
            this.logger.warn(`card_action forward to chat failed aqId=${aqId} taskId=${taskIdForChat}: ${(e as Error).message}`);
          }
        };
        const qRow = await (this.prisma as any).agentQuestion.findUnique({
          where: { id: aqId },
        });
        if (!qRow) {
          await this.delivery.log(
            DELIVERY_DIRECTIONS.inbound,
            'card_action',
            DELIVERY_STATUS.rejected,
            {
              channelId,
              externalId: aqId,
              error: 'question not found',
              payload: cmd as unknown,
            },
          );
          // Still forward selection to task chat for generic template_card interactions so model sees it even without pending question
          try {
            const fallbackTaskId = boundTaskIds[0] ?? null;
            const opIdFb = (cmd as any).operatorExternalId as string | undefined;
            const opNameFb = ((cmd as any).operatorExternalName as string | undefined) ?? ((cmd as any).operatorName as string | undefined) ?? opIdFb ?? '';
            await forwardSelectionToChat(fallbackTaskId, opIdFb, opNameFb);
          } catch {}
          results.push({ ok: false });
          continue;
        }
        if (qRow.status !== AGENT_QUESTION_STATUS.PENDING) {
          await this.delivery.log(
            DELIVERY_DIRECTIONS.inbound,
            'card_action',
            DELIVERY_STATUS.skipped,
            {
              channelId,
              externalId: aqId,
              error: `status ${qRow.status} not pending`,
              payload: cmd as unknown,
            },
          );
          results.push({ ok: false });
          continue;
        }
        if (qRow.taskId && !boundTaskIds.includes(qRow.taskId)) {
          await this.delivery.log(
            DELIVERY_DIRECTIONS.inbound,
            'card_action',
            DELIVERY_STATUS.rejected,
            {
              channelId,
              externalId: aqId,
              error: 'task mismatch',
              payload: cmd as unknown,
            },
          );
          results.push({ ok: false });
          continue;
        }
        const age = Date.now() - new Date(qRow.createdAt).getTime();
        if (age > QUESTION_PENDING_TTL_MS) {
          await this.delivery.log(
            DELIVERY_DIRECTIONS.inbound,
            'card_action',
            DELIVERY_STATUS.skipped,
            {
              channelId,
              externalId: aqId,
              error: 'expired',
              payload: cmd as unknown,
            },
          );
          results.push({ ok: false });
          continue;
        }
        if (qRow.kind === AGENT_QUESTION_KINDS.PERMISSION) {
          if (action !== 'approve' && action !== 'reject') {
            await this.delivery.log(
              DELIVERY_DIRECTIONS.inbound,
              'card_action',
              DELIVERY_STATUS.rejected,
              {
                channelId,
                externalId: aqId,
                error: `invalid action ${action} for permission`,
                payload: cmd as unknown,
              },
            );
            results.push({ ok: false });
            continue;
          }
        } else if (qRow.kind === AGENT_QUESTION_KINDS.QUESTION) {
          if (!action) {
            await this.delivery.log(
              DELIVERY_DIRECTIONS.inbound,
              'card_action',
              DELIVERY_STATUS.rejected,
              {
                channelId,
                externalId: aqId,
                error: 'missing action for question',
                payload: cmd as unknown,
              },
            );
            results.push({ ok: false });
            continue;
          }
        } else {
          await this.delivery.log(
            DELIVERY_DIRECTIONS.inbound,
            'card_action',
            DELIVERY_STATUS.rejected,
            {
              channelId,
              externalId: aqId,
              error: `unknown kind ${qRow.kind}`,
              payload: cmd as unknown,
            },
          );
          results.push({ ok: false });
          continue;
        }

        if (!this.questionsService) {
          await this.delivery.log(
            DELIVERY_DIRECTIONS.inbound,
            'card_action',
            DELIVERY_STATUS.failed,
            {
              channelId,
              externalId: aqId,
              error: 'questionsService not available',
              payload: cmd as unknown,
            },
          );
          results.push({ ok: false });
          continue;
        }
        const opId = (cmd as any).operatorExternalId as string | undefined;
        const opName =
          ((cmd as any).operatorExternalName as string | undefined) ??
          ((cmd as any).operatorName as string | undefined) ??
          opId ??
          '';
        const opChattype = (cmd as any).chattype as string | undefined;
        try {
          const adapter = this.registry?.get?.('wecom_aibot') as unknown as
            | {
                setPendingOperatorForTask?: (
                  taskId: string,
                  info: {
                    channelId: string;
                    fromUserId: string;
                    fromUserName: string;
                    chattype?: string;
                    aqId?: string;
                  },
                ) => void;
                setPendingOperatorForAq?: (
                  aqId: string,
                  info: {
                    channelId: string;
                    fromUserId: string;
                    fromUserName: string;
                    chattype?: string;
                  },
                ) => void;
              }
            | undefined;
          if (adapter && opId && qRow.taskId) {
            if (typeof adapter.setPendingOperatorForTask === 'function') {
              adapter.setPendingOperatorForTask(qRow.taskId, {
                channelId,
                fromUserId: opId,
                fromUserName: opName || opId,
                chattype: opChattype,
                aqId,
              });
            } else if (
              typeof adapter.setPendingOperatorForAq === 'function'
            ) {
              adapter.setPendingOperatorForAq(aqId, {
                channelId,
                fromUserId: opId,
                fromUserName: opName || opId,
                chattype: opChattype,
              });
            }
            this.logger.log(
              `card_action stored pending operator taskId=${qRow.taskId} aqId=${aqId} op=${opId} name=${opName} chattype=${opChattype ?? ''}`,
            );
          }
        } catch (e) {
          this.logger.warn(
            `store pending operator failed aqId=${aqId}: ${(e as Error).message}`,
          );
        }
        try {
          if (qRow.kind === AGENT_QUESTION_KINDS.PERMISSION) {
            const response = action === 'approve' ? 'once' : 'reject';
            await this.questionsService.reply(
              aqId,
              { response } as any,
              '__external__',
            );
          } else {
            const answers = [[action]];
            await this.questionsService.reply(
              aqId,
              { answers } as any,
              '__external__',
            );
          }
          await this.delivery.log(
            DELIVERY_DIRECTIONS.inbound,
            'card_action',
            DELIVERY_STATUS.ok,
            {
              channelId,
              externalId: aqId,
              payload: cmd as unknown,
              meta: {
                action,
                operatorExternalId: opId ?? null,
                operatorExternalName: opName ?? null,
                chattype: opChattype ?? null,
                taskId: qRow.taskId ?? null,
              } as unknown,
            },
          );
          await forwardSelectionToChat(qRow.taskId, opId, opName);
          results.push({ ok: true });
        } catch (e) {
          const errMsg = (e as Error).message ?? String(e);
          await this.delivery.log(
            DELIVERY_DIRECTIONS.inbound,
            'card_action',
            DELIVERY_STATUS.failed,
            {
              channelId,
              externalId: aqId,
              error: errMsg,
              payload: cmd as unknown,
            },
          );
          results.push({ ok: false });
        }
        continue;
      }

      await this.delivery.log(
        DELIVERY_DIRECTIONS.inbound,
        (cmd as { kind?: string }).kind ?? null,
        DELIVERY_STATUS.rejected,
        { channelId, error: 'unknown command kind', payload: cmd as unknown },
      );
      results.push({ ok: false });
    }
    return { results };
  }
}
