import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService, RealtimeEvent } from '../realtime/realtime.service';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { MessageRegistryService } from './message-registry.service';
import { MessageDeliveryService } from './message-delivery.service';
import { WecomAibotAdapter } from './adapters/wecom-aibot.adapter';
import {
  MESSAGE_CHANNEL_TYPES,
  DELIVERY_DIRECTIONS,
  DELIVERY_STATUS,
  parseTeamScopedTaskId,
} from './message-channel.constants';

/**
 * 问题/权限卡片的纯文本兜底文案（卡片发不出去时保证用户侧有感知）。
 *
 * 与通知渠道期的文案同口径：权限请求带标题与路径 pattern（截断防刷屏），
 * 单问题带题面，多问题只报数量。**不含任何交互动作**——兜底只负责"告知去处理"，
 * 真正的批准/答复仍走 Web 弹窗或 opencode 原生页面（应答需要 aqId/requestId 上下文）。
 */
export function buildQuestionFallbackText(question: {
  kind?: string;
  content?: any;
}): string {
  const kind = question.kind ?? 'question';
  const content = question.content ?? {};
  if (kind === 'permission') {
    const title =
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
    return `【权限请求】${title}${pattern ? ` - ${pattern}` : ''}（请前往 Web / opencode 页面处理）`;
  }
  const questions: any[] = Array.isArray(content.questions)
    ? content.questions
    : [];
  if (questions.length > 1) {
    return `【待确认】${questions.length} 个问题待处理，请前往 Web 处理`;
  }
  if (questions.length === 1) {
    const q0 = questions[0] ?? {};
    const text =
      typeof q0.question === 'string'
        ? q0.question
        : typeof q0.header === 'string'
          ? q0.header
          : '';
    return `【待确认】${text ? text.slice(0, 200) : '有 1 个问题待处理'}（请前往 Web 处理）`;
  }
  const fallback =
    typeof content.text === 'string'
      ? content.text
      : typeof content.header === 'string'
        ? content.header
        : typeof content.title === 'string'
          ? content.title
          : '';
  return `【待确认】${fallback ? fallback.slice(0, 200) : '有确认请求待处理'}（请前往 Web 处理）`;
}

@Injectable()
export class MessageQuestionDispatcher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MessageQuestionDispatcher.name);
  private unsubscribe: (() => void) | null = null;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
    private readonly registry: MessageRegistryService,
    private readonly delivery: MessageDeliveryService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribe = this.realtime.subscribe((event) => {
      if (event.type !== EVENT_TYPES.AGENT_QUESTION) return;
      void this.handle(event).catch((err: unknown) =>
        this.logger.error(
          `handle AGENT_QUESTION failed: ${(err as Error).message}`,
        ),
      );
    });
    this.logger.log('MessageQuestionDispatcher subscribed to AGENT_QUESTION');
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.queues.clear();
  }

  async handle(event: RealtimeEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      managed?: boolean;
      resolved?: boolean;
      taskId?: string | null;
      question?: {
        id?: string;
        requestId?: string;
        taskId?: string | null;
        kind?: string;
        content?: unknown;
        status?: string;
        managedMode?: boolean;
        managed?: boolean;
      } & Record<string, unknown>;
    };
    if (payload.resolved === true) return;
    const question = payload.question;
    if (!question) return;
    const status = question.status as string | undefined;
    if (status !== undefined && status !== 'pending') return;

    const taskId: string | null =
      (question.taskId as string | null) ?? (payload as any).taskId ?? null;
    if (!taskId) return;

    const isManaged =
      question.managedMode === true ||
      question.managed === true ||
      payload.managed === true;

    if (isManaged) {
      const shouldSendForManaged = await this.isSelfLoopTask(
        taskId,
        question as any,
      );
      if (!shouldSendForManaged) return;
      this.logger.log(
        `managed self-loop question will still send WeCom card taskId=${taskId} requestId=${question.requestId ?? question.id}`,
      );
    }

    const channels = await this.resolveWecomChannelsForTask(taskId);
    if (channels.length === 0) return;

    const aqId =
      (question.id as string) ?? (question.requestId as string) ?? '';
    const kind = (question.kind as string) ?? 'question';
    const content = (question as any).content ?? question;

    const prismaRow = aqId
      ? await (this.prisma as any).agentQuestion
          .findUnique({
            where: { id: aqId },
            select: {
              id: true,
              requestId: true,
              kind: true,
              content: true,
              status: true,
            },
          })
          .catch(() => null)
      : null;

    const dispatchQuestion = prismaRow
      ? {
          id: prismaRow.id,
          requestId: prismaRow.requestId,
          kind: prismaRow.kind,
          content: prismaRow.content,
        }
      : {
          id: aqId,
          requestId: question.requestId as string | undefined,
          kind,
          content,
        };

    if (prismaRow && prismaRow.status !== 'pending') return;

    for (const ch of channels) {
      void this.dispatchToChannel(ch, dispatchQuestion).catch(() => {});
    }
  }

  /**
   * 定向给任务/团队域发问题卡片（托管自环等平台内部路径调用）。
   *
   * 返回语义（P0：主 Agent 权限卡片静默丢失 aq_0000000478）：
   * `true` = 至少一个渠道送达（卡片成功，或卡片失败但文本兜底成功）；
   * `false` = 无绑定渠道 / 全部渠道发送失败——调用方据此记告警，不再打印「已委托」假成功日志。
   */
  async dispatchQuestionCard(
    taskId: string,
    questionRow: {
      id: string;
      requestId?: string;
      kind: string;
      content: any;
      /** 发起提问的会话（用于解析成员级渠道绑定；成员私聊场景必需）。 */
      sessionId?: string;
    },
  ): Promise<boolean> {
    const channels = await this.resolveWecomChannelsForTask(
      taskId,
      questionRow.sessionId,
    );
    if (channels.length === 0) {
      this.logger.warn(
        `dispatchQuestionCard no wecom channels bound taskId=${taskId} aqId=${questionRow.id}`,
      );
      return false;
    }
    let delivered = 0;
    for (const ch of channels) {
      const ok = await this.dispatchToChannel(ch, questionRow);
      if (ok) delivered += 1;
    }
    if (delivered === 0) {
      this.logger.warn(
        `dispatchQuestionCard all channels failed taskId=${taskId} aqId=${questionRow.id} channels=${channels.length}`,
      );
    }
    return delivered > 0;
  }

  /**
   * 托管自循环判定（session-unification Todo 9：团队主门）：
   * 任务所属团队的 team.mainAgentMemberId === 提问会话的 teamMemberId 时，
   * 托管 question 仍需下发 WeCom 卡片（主 Agent 在企微侧确认），余者跳过。
   */
  private async isSelfLoopTask(
    taskId: string,
    question: { sessionId?: string },
  ): Promise<boolean> {
    try {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      const teamId = task?.teamId as string | undefined;
      if (!teamId || !question.sessionId) return false;
      const [team, sess] = await Promise.all([
        (this.prisma as any).team.findUnique({
          where: { id: teamId },
          select: { mainAgentMemberId: true },
        }),
        (this.prisma as any).session
          .findUnique({
            where: { id: question.sessionId },
            select: { teamMemberId: true },
          })
          .catch(() => null),
      ]);
      if (!team?.mainAgentMemberId || !sess?.teamMemberId) return false;
      return sess.teamMemberId === team.mainAgentMemberId;
    } catch {
      return false;
    }
  }

  /**
   * 解析问题/权限卡片的企微渠道（域分流：任务域查任务绑定，团队域查团队绑定）。
   *
   * `team:<teamId>`（团队直聊无任务）是团队域占位，不是任务主键——
   * 必须走 `team_message_channels`（团队绑定），否则查任务绑定必然 0 行，
   * 卡片静默丢失（生产事故 aq_0000000478：主 Agent 权限请求挂死 3.5h 无通知）。
   */
  private async resolveWecomChannelsForTask(
    taskId: string,
    sessionId?: string,
  ): Promise<any[]> {
    const teamScopedId = parseTeamScopedTaskId(taskId);
    const ids = teamScopedId
      ? await this.teamBoundChannelIds(teamScopedId)
      : await this.taskBoundChannelIds(taskId);
    /**
     * **成员级渠道回落**（2026-11-13 用户反馈）：入站渠道可以绑定到成员，
     * 消息直达成员私聊。该成员在私聊里触发 question/权限确认时，卡片也必须
     * 发到他绑定的企微渠道——否则用户在企微端完全看不到弹窗（线上实测：
     * 私聊提问只在 vteam web 弹窗出现，企微无感）。
     */
    if (ids.length === 0 && sessionId) {
      const memberIds = await this.memberBoundChannelIdsForSession(sessionId);
      ids.push(...memberIds);
    }
    if (ids.length === 0) return [];
    let channels: any[];
    try {
      channels = await (this.prisma as any).messageChannel.findMany({
        where: {
          id: { in: ids },
          enabled: true,
          type: MESSAGE_CHANNEL_TYPES.wecom_aibot,
        },
      });
    } catch (err) {
      // 渠道表读取失败 → 按"无可用渠道"降级（不给提问链路抛错）
      void err;
      return [];
    }
    return channels ?? [];
  }

  /** 任务域企微渠道 id（task_message_channels；读失败/未绑定 → 空）。 */
  private async taskBoundChannelIds(taskId: string): Promise<string[]> {
    let links: Array<{ messageChannelId: string }>;
    try {
      links = await (this.prisma as any).taskMessageChannel.findMany({
        where: { taskId },
        select: { messageChannelId: true },
      });
    } catch (err) {
      // 任务域渠道关联读失败 → 按"未绑定"降级，不阻断提问
      void err;
      return [];
    }
    if (!links || links.length === 0) return [];
    return links.map((l) => l.messageChannelId).filter(Boolean);
  }

  /**
   * 成员级企微渠道 id（member_message_channels）：按会话 → 席位 → 成员解析。
   *
   * 成员私聊（渠道绑成员）场景下团队/任务都没有绑定，卡片只能走这条路径。
   */
  private async memberBoundChannelIdsForSession(
    sessionId: string,
  ): Promise<string[]> {
    try {
      const sess = await (this.prisma as any).session.findUnique({
        where: { id: sessionId },
        select: { teamMemberId: true },
      });
      const teamMemberId: string | null = sess?.teamMemberId ?? null;
      if (!teamMemberId) return [];
      const seat = await (this.prisma as any).teamMember.findUnique({
        where: { id: teamMemberId },
        select: { memberId: true },
      });
      const memberId: string | null = seat?.memberId ?? null;
      if (!memberId) return [];
      const links = await (this.prisma as any).memberMessageChannel.findMany({
        where: { memberId },
        select: { messageChannelId: true },
      });
      return (links as Array<{ messageChannelId: string }>)
        .map((l) => l.messageChannelId)
        .filter(Boolean);
    } catch {
      // 读失败 → 按「未绑定」降级，不阻断提问链路
      return [];
    }
  }

  /** 团队域企微渠道 id（team_message_channels；团队直聊无任务的唯一绑定源）。 */
  private async teamBoundChannelIds(teamId: string): Promise<string[]> {
    let links: Array<{ messageChannelId: string }>;
    try {
      links = await (this.prisma as any).teamMessageChannel.findMany({
        where: { teamId },
        select: { messageChannelId: true },
      });
    } catch (err) {
      // 团队域渠道关联读失败 → 按"未绑定"降级，不阻断提问
      void err;
      return [];
    }
    if (!links || links.length === 0) return [];
    return links.map((l) => l.messageChannelId).filter(Boolean);
  }

  /**
   * 向单渠道送卡片（按渠道串行排队）。
   *
   * 返回语义：`true` = 卡片送达，或卡片失败后纯文本兜底送达；`false` = 两者都没成。
   * 兜底动机（P0，aq_0000000478 同类事故）：企微模板卡片可能被机器人侧拒绝
   * （权限/机型限制/errcode），若无兜底，用户侧完全无感、会话静默挂死在权限上。
   * 兜底只发「请前往 Web/opencode 处理」一句话，不承载应答动作。
   */
  private async dispatchToChannel(
    channel: any,
    question: { id: string; kind: string; content: any },
  ): Promise<boolean> {
    const prev = this.queues.get(channel.id) ?? Promise.resolve();
    const run = prev.then(() => this.dispatchToChannelOnce(channel, question));
    // 队列只跟踪「上一单已结束」，不传播结果（异常已在 Once 内收敛为 false）。
    this.queues.set(
      channel.id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** 单次投递（脱离队列的实现体）：卡片失败 → 文本兜底；任何异常都不外抛。 */
  private async dispatchToChannelOnce(
    channel: any,
    question: { id: string; kind: string; content: any },
  ): Promise<boolean> {
    let adapter: WecomAibotAdapter | undefined;
    let deliveryId: string | null = null;
    try {
      const logRes = await this.delivery.log(
        DELIVERY_DIRECTIONS.outbound,
        'question_card',
        'pending',
        { channelId: channel.id, payload: question as unknown },
      );
      deliveryId = (logRes as { id: string })?.id ?? null;

      adapter = this.registry.get(MESSAGE_CHANNEL_TYPES.wecom_aibot) as
        WecomAibotAdapter | undefined;
      if (!adapter || typeof (adapter as any).sendQuestionCard !== 'function') {
        throw new Error(
          `adapter not found for type ${MESSAGE_CHANNEL_TYPES.wecom_aibot}`,
        );
      }
      const resolved = {
        id: channel.id,
        type: channel.type,
        config: (channel.config as Record<string, any>) ?? {},
        secrets: (channel.secrets as Record<string, any>) ?? {},
        enabled: channel.enabled ?? true,
      };
      const res = await (adapter as any).sendQuestionCard(resolved, question);
      if (deliveryId) {
        try {
          await this.delivery.finish(
            deliveryId,
            DELIVERY_STATUS.ok,
            null,
            question as unknown,
            res as unknown,
          );
        } catch {}
      }
      this.logger.log(
        `wecom question card sent channel=${channel.id} aqId=${question.id} kind=${question.kind}`,
      );
      return true;
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      this.logger.error(
        `dispatchToChannel failed channel=${channel.id} aqId=${question.id}: ${errMsg}`,
      );
      try {
        if (deliveryId) {
          await this.delivery.finish(
            deliveryId,
            DELIVERY_STATUS.failed,
            errMsg,
            question as unknown,
            null,
          );
        } else {
          await this.delivery.log(
            DELIVERY_DIRECTIONS.outbound,
            'question_card',
            DELIVERY_STATUS.failed,
            {
              channelId: channel.id,
              error: errMsg,
              payload: question as unknown,
            },
          );
        }
      } catch {}
      return this.sendQuestionFallbackText(channel, question, adapter, errMsg);
    }
  }

  /**
   * 卡片不可达时的纯文本兜底（第二道保险）。
   *
   * 只走 `sendNewMessage`（渠道级 lastChatid 已由入站消息维护），不发交互卡片——
   * 保证用户至少知道「有权限/问题等你去 Web/opencode 处理」。
   * 失败仅记日志与投递流水（kind='question_card_fallback'），不抛错。
   */
  private async sendQuestionFallbackText(
    channel: any,
    question: { id: string; kind: string; content: any },
    adapter: WecomAibotAdapter | undefined,
    cardError: string,
  ): Promise<boolean> {
    const send = (
      adapter as unknown as
        | {
            sendNewMessage?: (
              channelId: string,
              text: string,
            ) => Promise<boolean>;
          }
        | undefined
    )?.sendNewMessage;
    if (typeof send !== 'function') return false;
    const text = buildQuestionFallbackText(question);
    try {
      const ok = await send.call(adapter, channel.id, text);
      if (ok) {
        this.logger.warn(
          `question card fallback text sent channel=${channel.id} aqId=${question.id} kind=${question.kind} cardError=${cardError}`,
        );
        await this.logFallbackDelivery(
          channel.id,
          DELIVERY_STATUS.ok,
          null,
          question,
        );
        return true;
      }
      this.logger.error(
        `question card fallback text not sent channel=${channel.id} aqId=${question.id}（sendNewMessage 返回 false）`,
      );
      await this.logFallbackDelivery(
        channel.id,
        DELIVERY_STATUS.failed,
        'sendNewMessage returned false',
        question,
      );
      return false;
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      this.logger.error(
        `question card fallback text failed channel=${channel.id} aqId=${question.id}: ${errMsg}`,
      );
      await this.logFallbackDelivery(
        channel.id,
        DELIVERY_STATUS.failed,
        errMsg,
        question,
      );
      return false;
    }
  }

  /** 兜底文本的投递流水（失败静默：日志主路径已记）。 */
  private async logFallbackDelivery(
    channelId: string,
    status: string,
    error: string | null,
    question: { id: string; kind: string; content: any },
  ): Promise<void> {
    try {
      await this.delivery.log(
        DELIVERY_DIRECTIONS.outbound,
        'question_card_fallback',
        status,
        {
          channelId,
          ...(error ? { error } : {}),
          payload: question as unknown,
        },
      );
    } catch {}
  }
}
